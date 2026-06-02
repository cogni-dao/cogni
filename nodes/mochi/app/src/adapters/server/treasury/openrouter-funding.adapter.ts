// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/treasury/openrouter-funding`
 * Purpose: ProviderFundingPort adapter — creates OpenRouter charges and funds them via operator wallet.
 * Scope: Manages provider_funding_attempts rows for crash recovery, calls OpenRouter API for charge creation,
 *   delegates on-chain funding to OperatorWalletPort. Error logging distinguishes timing errors from real failures.
 * Invariants:
 *   - DURABLE_FUNDING_ROW: provider_funding_attempts keyed by paymentIntentId for crash recovery
 *   - PORT_BOUNDARY_CLEAN: delegates to OperatorWalletPort.fundOpenRouterTopUp() — no raw signing
 *   - DETERMINISTIC_IDS: uuid5(TB_TRANSFER_NAMESPACE, paymentIntentId + ":" + stepCode) for TB transfer IDs
 * Side-effects: IO (Postgres writes, HTTP to OpenRouter API, on-chain tx via OperatorWalletPort)
 * Links: docs/spec/web3-openrouter-payments.md, task.0086
 * @public
 */

import { providerFundingAttempts } from "@cogni/db-schema/billing";
import { TB_TRANSFER_NAMESPACE } from "@cogni/financial-ledger";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { v5 as uuidv5 } from "uuid";
import type { Database } from "@/adapters/server";
import type {
  OperatorWalletPort,
  ProviderFundingContext,
  ProviderFundingOutcome,
  ProviderFundingPort,
  TransferIntent,
} from "@/ports";

/**
 * Configuration for OpenRouterFundingAdapter.
 */
export interface OpenRouterFundingConfig {
  /** OpenRouter API key */
  apiKey: string;
}

/**
 * OpenRouter /api/v1/credits/coinbase response envelope.
 * Actual API shape: `{ data: OpenRouterChargeData }`.
 * The `web3_data.transfer_intent` contains the Coinbase Commerce payment intent.
 * Validated against spike.0090 (scripts/experiments/openrouter-topup.ts:50-60).
 */
interface OpenRouterChargeData {
  id: string;
  created_at: string;
  expires_at: string;
  web3_data: {
    transfer_intent: TransferIntent;
  };
}

/**
 * ProviderFundingPort adapter for OpenRouter via Coinbase Commerce protocol.
 * Creates charges, funds them via operator wallet, manages durable state.
 */
export class OpenRouterFundingAdapter implements ProviderFundingPort {
  constructor(
    private readonly db: Database,
    private readonly wallet: OperatorWalletPort,
    private readonly config: OpenRouterFundingConfig,
    private readonly log: Logger
  ) {}

  async fundAfterCreditPurchase(
    context: ProviderFundingContext
  ): Promise<ProviderFundingOutcome | undefined> {
    const { paymentIntentId, topUpUsd } = context;

    if (topUpUsd <= 0) {
      this.log.warn(
        { paymentIntentId, topUpUsd },
        "provider funding skipped — top-up amount is zero or negative"
      );
      return undefined;
    }

    // Check for existing attempt (crash recovery)
    const existing = await this.db
      .select()
      .from(providerFundingAttempts)
      .where(eq(providerFundingAttempts.paymentIntentId, paymentIntentId))
      .limit(1);

    const row = existing[0];
    if (row) {
      if (row.status === "funded") {
        this.log.info(
          { paymentIntentId, txHash: row.fundingTxHash },
          "provider funding already completed — idempotent skip"
        );
        return row.fundingTxHash
          ? { txHash: row.fundingTxHash, topUpUsd }
          : undefined;
      }
      // Resume from charge_created or pending
      if (row.status === "charge_created" && row.chargeId) {
        return this.resumeFromCharge(
          paymentIntentId,
          row.id,
          row.chargeId,
          topUpUsd
        );
      }
      // If failed, skip (don't retry failed attempts automatically)
      if (row.status === "failed") {
        this.log.warn(
          { paymentIntentId, error: row.errorMessage },
          "provider funding previously failed — skipping"
        );
        return undefined;
      }
    }

    // Create new funding attempt — deterministic ID for idempotent inserts
    const attemptId = uuidv5(paymentIntentId, TB_TRANSFER_NAMESPACE);
    const amountUsdcMicro = BigInt(Math.round(topUpUsd * 1_000_000));

    await this.db.insert(providerFundingAttempts).values({
      id: attemptId,
      paymentIntentId,
      status: "pending",
      provider: "openrouter",
      amountUsdcMicro,
    });

    // Step 1: Create OpenRouter charge
    let chargeResponse: OpenRouterChargeData;
    try {
      chargeResponse = await this.createOpenRouterCharge(topUpUsd);
    } catch (err) {
      await this.markFailed(attemptId, err);
      throw err;
    }

    // Step 2: Update row with charge details
    await this.db
      .update(providerFundingAttempts)
      .set({
        status: "charge_created",
        chargeId: chargeResponse.id,
        updatedAt: new Date(),
      })
      .where(eq(providerFundingAttempts.id, attemptId));

    // Step 3: Fund via operator wallet
    return this.fundCharge(
      paymentIntentId,
      attemptId,
      chargeResponse.web3_data.transfer_intent,
      topUpUsd
    );
  }

  private async resumeFromCharge(
    paymentIntentId: string,
    attemptId: string,
    _previousChargeId: string,
    topUpUsd: number
  ): Promise<ProviderFundingOutcome | undefined> {
    this.log.info(
      { paymentIntentId },
      "provider funding resuming — creating fresh charge"
    );

    // Create a new charge (previous charge may have expired).
    // Update the row so chargeId stays consistent with what we fund.
    let chargeResponse: OpenRouterChargeData;
    try {
      chargeResponse = await this.createOpenRouterCharge(topUpUsd);
    } catch (err) {
      await this.markFailed(attemptId, err);
      throw err;
    }

    await this.db
      .update(providerFundingAttempts)
      .set({
        chargeId: chargeResponse.id,
        updatedAt: new Date(),
      })
      .where(eq(providerFundingAttempts.id, attemptId));

    return this.fundCharge(
      paymentIntentId,
      attemptId,
      chargeResponse.web3_data.transfer_intent,
      topUpUsd
    );
  }

  private async fundCharge(
    paymentIntentId: string,
    attemptId: string,
    intent: TransferIntent,
    topUpUsd: number
  ): Promise<ProviderFundingOutcome> {
    let txHash: string;
    try {
      txHash = await this.wallet.fundOpenRouterTopUp(intent);
    } catch (err) {
      // Distinguish timing errors from real failures
      const isTimingError =
        err instanceof Error &&
        (err.message.includes("insufficient") ||
          err.message.includes("balance"));
      const reasonCode = isTimingError
        ? "insufficient_balance_timing"
        : "funding_failed";

      this.log.error(
        { paymentIntentId, reasonCode, err },
        `provider funding failed — ${reasonCode}`
      );
      await this.markFailed(attemptId, err);
      throw err;
    }

    // Mark as funded
    await this.db
      .update(providerFundingAttempts)
      .set({
        status: "funded",
        fundingTxHash: txHash,
        updatedAt: new Date(),
      })
      .where(eq(providerFundingAttempts.id, attemptId));

    this.log.info(
      { paymentIntentId, txHash, topUpUsd },
      "provider funding completed"
    );

    return { txHash, topUpUsd };
  }

  private async markFailed(attemptId: string, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await this.db
      .update(providerFundingAttempts)
      .set({
        status: "failed",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(providerFundingAttempts.id, attemptId));
  }

  /**
   * Create an OpenRouter crypto charge via their API.
   * Returns the charge ID and transfer_intent for on-chain funding.
   */
  private async createOpenRouterCharge(
    amountUsd: number
  ): Promise<OpenRouterChargeData> {
    const response = await fetch(
      "https://openrouter.ai/api/v1/credits/coinbase",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountUsd,
          chain_id: 8453, // Base
          sender: await this.wallet.getAddress(),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenRouter charge creation failed: ${response.status} ${body}`
      );
    }

    const data = (await response.json()) as {
      data: OpenRouterChargeData;
    };
    return data.data;
  }
}
