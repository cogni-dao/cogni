// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/accounts/drizzle`
 * Purpose: Drizzle account service implementations for PostgreSQL billing account operations with charge receipt + llm_charge_details recording.
 * Scope: Implements AccountService and ServiceAccountService ports with ledger-based credit accounting and virtual key management. Does not compute pricing.
 * Invariants:
 * - Atomic ops; ledger source of truth; balance cached; UUID v4 validated
 * - CO_WRITE_NON_BLOCKING: TigerBeetle co-writes fire after PG tx commits; failures logged, never thrown
 * - IDEMPOTENT_CHARGES: (source_system, source_reference) is idempotency key per GRAPH_EXECUTION.md
 * - Persists chargeReason, sourceSystem, runId to charge_receipts (required fields)
 * - listChargeReceipts returns sourceSystem for Activity UI join
 * - listLlmChargeDetails fetches LLM telemetry (model/tokens/provider/latency/graphId) for receipt enrichment
 * - UserDrizzleAccountService wraps all queries in withTenantScope (RLS enforced)
 * - ServiceDrizzleAccountService uses serviceDb directly (BYPASSRLS)
 * Side-effects: IO (database operations)
 * Notes: Uses transactions for consistency; recordChargeReceipt is non-blocking (never throws InsufficientCredits per ACTIVITY_METRICS.md)
 * Links: Implements AccountService port, uses shared database schema, docs/spec/activity-metrics.md, docs/spec/graph-execution.md, docs/spec/financial-ledger.md, types/billing.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import type { GraphId } from "@cogni/ai-core";
import { withTenantScope } from "@cogni/db-client";
import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import {
  ACCOUNT,
  LEDGER,
  TRANSFER_CODE,
  uuidToBigInt,
} from "@cogni/financial-ledger";
import { type ActorId, type UserId, userActor } from "@cogni/ids";
import type { SourceSystem } from "@cogni/node-core";
import { EVENT_NAMES, isValidUuid } from "@cogni/node-shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/adapters/server/db/client";
import {
  type AccountService,
  type BillingAccount,
  BillingAccountNotFoundPortError,
  type ChargeReceiptParams,
  type CreditLedgerEntry,
  InsufficientCreditsPortError,
  type ServiceAccountService,
  VirtualKeyNotFoundPortError,
} from "@/ports";
import {
  billingAccounts,
  chargeReceipts,
  creditLedger,
  llmChargeDetails,
  virtualKeys,
} from "@/shared/db";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "DrizzleAccountService" });

/**
 * Extracts a human-readable fingerprint from DATABASE_URL for error messages.
 * Returns "host:port/db" or the raw URL if parsing fails.
 */
function getDbFingerprint(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const db = url.pathname.replace(/^\//, ""); // remove leading slash
    return `${url.hostname}:${url.port || "5432"}/${db}`;
  } catch {
    // Fallback for non-standard URLs (e.g., sqlite://)
    return databaseUrl;
  }
}

interface QueryableDb extends Pick<Database, "query" | "insert"> {
  query: Database["query"];
  insert: Database["insert"];
}

interface VirtualKeyRow {
  id: string;
}

type CreditLedgerRow = typeof creditLedger.$inferSelect;

// --- Free functions (shared by both service classes) ---

function toNumber(value: number | string | bigint): number {
  return typeof value === "number" ? value : Number(value);
}

function normalizeAmount(
  rawAmount: number,
  options: { enforceMinimumOne?: boolean } = {}
): number {
  const rounded = Math.round(rawAmount);
  if (options.enforceMinimumOne && rounded === 0) {
    return 1;
  }
  return rounded;
}

function mapLedgerRow(row: CreditLedgerRow): CreditLedgerEntry {
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    virtualKeyId: row.virtualKeyId,
    amount: toNumber(row.amount),
    balanceAfter: toNumber(row.balanceAfter),
    reason: row.reason,
    reference: row.reference ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  };
}

async function ensureBillingAccountExists(
  tx: QueryableDb,
  billingAccountId: string
): Promise<void> {
  const account = await tx.query.billingAccounts.findFirst({
    where: eq(billingAccounts.id, billingAccountId),
  });

  if (!account) {
    throw new BillingAccountNotFoundPortError(billingAccountId);
  }
}

async function ensureVirtualKeyExists(
  tx: QueryableDb,
  billingAccountId: string,
  virtualKeyId: string
): Promise<void> {
  const key = await tx.query.virtualKeys.findFirst({
    where: and(
      eq(virtualKeys.billingAccountId, billingAccountId),
      eq(virtualKeys.id, virtualKeyId)
    ),
  });

  if (!key) {
    throw new VirtualKeyNotFoundPortError(billingAccountId, virtualKeyId);
  }
}

async function findDefaultKey(
  tx: QueryableDb,
  billingAccountId: string
): Promise<VirtualKeyRow> {
  const defaultKey = await tx.query.virtualKeys.findFirst({
    where: and(
      eq(virtualKeys.billingAccountId, billingAccountId),
      eq(virtualKeys.isDefault, true)
    ),
  });

  if (!defaultKey) {
    throw new VirtualKeyNotFoundPortError(billingAccountId);
  }

  return {
    id: defaultKey.id,
  };
}

async function insertDefaultKey(
  tx: QueryableDb,
  billingAccountId: string,
  params: { label?: string }
): Promise<VirtualKeyRow> {
  // MVP: virtual_keys is scope/FK handle only. Auth uses LITELLM_MASTER_KEY from env.
  const [created] = await tx
    .insert(virtualKeys)
    .values({
      billingAccountId,
      label: params.label ?? "Default",
      isDefault: true,
      active: true,
    })
    .returning({
      id: virtualKeys.id,
    });

  if (!created) {
    throw new VirtualKeyNotFoundPortError(billingAccountId);
  }

  return created;
}

// --- UserDrizzleAccountService (appDb, RLS enforced) ---

export class UserDrizzleAccountService implements AccountService {
  private readonly actorId: ActorId;

  constructor(
    private readonly db: Database,
    userId: UserId,
    private readonly financialLedger?: FinancialLedgerPort
  ) {
    this.actorId = userActor(userId);
  }

  async getBillingAccountById(
    billingAccountId: string
  ): Promise<BillingAccount | null> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const account = await tx.query.billingAccounts.findFirst({
        where: eq(billingAccounts.id, billingAccountId),
      });

      if (!account) {
        return null;
      }

      const defaultKey = await tx.query.virtualKeys.findFirst({
        where: and(
          eq(virtualKeys.billingAccountId, billingAccountId),
          eq(virtualKeys.isDefault, true)
        ),
      });

      if (!defaultKey) {
        return null;
      }

      return {
        id: account.id,
        ownerUserId: account.ownerUserId,
        balanceCredits: toNumber(account.balanceCredits),
        defaultVirtualKeyId: defaultKey.id,
      };
    });
  }

  async getOrCreateBillingAccountForUser({
    userId,
    displayName,
  }: {
    userId: string;
    walletAddress?: string;
    displayName?: string;
  }): Promise<BillingAccount> {
    if (!isValidUuid(userId)) {
      const dbFingerprint = getDbFingerprint(serverEnv().DATABASE_URL);
      throw new Error(
        `BUG: expected valid UUID v4 for owner_user_id, got: ${userId}. DB: ${dbFingerprint}`
      );
    }

    return withTenantScope(this.db, this.actorId, async (tx) => {
      const existingAccount = await tx.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, userId),
      });

      if (existingAccount) {
        const defaultKey = await findDefaultKey(tx, existingAccount.id);
        return {
          id: existingAccount.id,
          ownerUserId: existingAccount.ownerUserId,
          balanceCredits: toNumber(existingAccount.balanceCredits),
          defaultVirtualKeyId: defaultKey.id,
        };
      }

      const billingAccountId = randomUUID();

      await tx.insert(billingAccounts).values({
        id: billingAccountId,
        ownerUserId: userId,
        balanceCredits: 0n,
        // Display name intentionally optional; stored later when UX surfaces exist
      });

      const createdKey = await insertDefaultKey(
        tx,
        billingAccountId,
        displayName ? { label: displayName } : {}
      );

      return {
        id: billingAccountId,
        ownerUserId: userId,
        balanceCredits: 0,
        defaultVirtualKeyId: createdKey.id,
      };
    });
  }

  async getBalance(billingAccountId: string): Promise<number> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const account = await tx.query.billingAccounts.findFirst({
        where: eq(billingAccounts.id, billingAccountId),
      });

      if (!account) {
        throw new BillingAccountNotFoundPortError(billingAccountId);
      }

      return toNumber(account.balanceCredits);
    });
  }

  async debitForUsage({
    billingAccountId,
    virtualKeyId,
    cost,
    requestId,
    metadata,
  }: {
    billingAccountId: string;
    virtualKeyId: string;
    cost: number;
    requestId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await withTenantScope(this.db, this.actorId, async (tx) => {
      await ensureBillingAccountExists(tx, billingAccountId);
      await ensureVirtualKeyExists(tx, billingAccountId, virtualKeyId);

      const normalizedCost = normalizeAmount(cost, {
        enforceMinimumOne: true,
      });
      const amount = BigInt(-normalizedCost);

      const [updatedAccount] = await tx
        .update(billingAccounts)
        .set({
          balanceCredits: sql`balance_credits + ${amount}`,
        })
        .where(eq(billingAccounts.id, billingAccountId))
        .returning({ balanceCredits: billingAccounts.balanceCredits });

      if (!updatedAccount) {
        throw new BillingAccountNotFoundPortError(billingAccountId);
      }

      const newBalance = updatedAccount.balanceCredits; // bigint

      await tx.insert(creditLedger).values({
        billingAccountId,
        virtualKeyId,
        amount,
        balanceAfter: newBalance,
        reason: "ai_usage",
        reference: requestId,
        metadata: metadata ?? null,
      });

      if (newBalance < 0n) {
        const previousBalance = Number(newBalance) + normalizedCost;
        throw new InsufficientCreditsPortError(
          billingAccountId,
          normalizedCost,
          previousBalance < 0 ? 0 : previousBalance
        );
      }
    });
  }

  async recordChargeReceipt(params: ChargeReceiptParams): Promise<void> {
    let committedReceiptId: string | undefined;

    await withTenantScope(this.db, this.actorId, async (tx) => {
      // Idempotency check: (source_system, source_reference) per GRAPH_EXECUTION.md
      // This prevents double-debits on retries
      const existing = await tx.query.chargeReceipts.findFirst({
        where: and(
          eq(chargeReceipts.sourceSystem, params.sourceSystem),
          eq(chargeReceipts.sourceReference, params.sourceReference)
        ),
      });
      if (existing) {
        logger.debug(
          {
            sourceSystem: params.sourceSystem,
            sourceReference: params.sourceReference,
          },
          "recordChargeReceipt: idempotent return - receipt already exists"
        );
        return;
      }

      await ensureBillingAccountExists(tx, params.billingAccountId);
      await ensureVirtualKeyExists(
        tx,
        params.billingAccountId,
        params.virtualKeyId
      );

      // Insert charge receipt (unique constraint on source_system, source_reference ensures no duplicates)
      const receiptId = randomUUID();
      const [receipt] = await tx
        .insert(chargeReceipts)
        .values({
          id: receiptId,
          billingAccountId: params.billingAccountId,
          virtualKeyId: params.virtualKeyId,
          runId: params.runId,
          attempt: params.attempt,
          ingressRequestId: params.ingressRequestId ?? null, // Optional ingress correlation
          litellmCallId: params.litellmCallId,
          chargedCredits: params.chargedCredits,
          responseCostUsd: params.responseCostUsd?.toString() ?? null,
          provenance: params.provenance,
          chargeReason: params.chargeReason,
          sourceSystem: params.sourceSystem,
          sourceReference: params.sourceReference,
          receiptKind: params.receiptKind,
        })
        .returning({ id: chargeReceipts.id });

      // Insert LLM detail row when receiptKind='llm' and detail provided
      if (receipt && params.llmDetail) {
        await tx.insert(llmChargeDetails).values({
          chargeReceiptId: receipt.id,
          providerCallId: params.llmDetail.providerCallId,
          model: params.llmDetail.model,
          provider: params.llmDetail.provider ?? null,
          tokensIn: params.llmDetail.tokensIn ?? null,
          tokensOut: params.llmDetail.tokensOut ?? null,
          latencyMs: params.llmDetail.latencyMs ?? null,
          graphId: params.llmDetail.graphId,
        });
      }

      // Debit credits atomically (negative amount)
      const debitAmount = -params.chargedCredits;

      const [updatedAccount] = await tx
        .update(billingAccounts)
        .set({
          balanceCredits: sql`${billingAccounts.balanceCredits} + ${debitAmount}`,
        })
        .where(eq(billingAccounts.id, params.billingAccountId))
        .returning({ balanceCredits: billingAccounts.balanceCredits });

      if (!updatedAccount) {
        throw new BillingAccountNotFoundPortError(params.billingAccountId);
      }

      const newBalance = updatedAccount.balanceCredits;

      // Insert ledger entry (unique partial index ensures no duplicates for charge_receipt reason)
      // reference = sourceReference for idempotent ledger writes per GRAPH_EXECUTION.md
      await tx.insert(creditLedger).values({
        billingAccountId: params.billingAccountId,
        virtualKeyId: params.virtualKeyId,
        amount: debitAmount,
        balanceAfter: newBalance,
        reason: "charge_receipt",
        reference: params.sourceReference,
        metadata: null,
      });

      // INVARIANT: Never throw InsufficientCreditsPortError in post-call path
      // Log critical if balance goes negative, but complete the write
      if (newBalance < 0n) {
        logger.error(
          {
            billingAccountId: params.billingAccountId,
            sourceReference: params.sourceReference,
            chargedCredits: Number(params.chargedCredits),
            newBalance: Number(newBalance),
          },
          "inv_post_call_negative_balance: Charge receipt recorded with negative balance"
        );
      }

      committedReceiptId = receipt?.id;
    });

    // CO_WRITE_NON_BLOCKING: TigerBeetle co-write AFTER Postgres tx commits.
    // Fires only if PG succeeded — avoids orphaned TB transfers on PG rollback.
    if (this.financialLedger && committedReceiptId) {
      this.financialLedger
        .transfer({
          id: uuidToBigInt(committedReceiptId),
          debitAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
          creditAccountId: ACCOUNT.REVENUE_AI_USAGE,
          amount: BigInt(params.chargedCredits),
          ledger: LEDGER.CREDIT,
          code: TRANSFER_CODE.AI_USAGE,
          userData128: uuidToBigInt(committedReceiptId),
        })
        .catch(() => {
          logger.error(
            {
              event: EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR,
              dep: "tigerbeetle",
              reasonCode: "co_write_charge_receipt",
              receiptId: committedReceiptId,
            },
            EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR
          );
        });
    }
  }

  async creditAccount({
    billingAccountId,
    amount,
    reason,
    reference,
    virtualKeyId,
    metadata,
  }: {
    billingAccountId: string;
    amount: number;
    reason: string;
    reference?: string;
    virtualKeyId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ newBalance: number }> {
    const ledgerEntryId = randomUUID();
    let committedAmount: bigint | undefined;

    const result = await withTenantScope(this.db, this.actorId, async (tx) => {
      await ensureBillingAccountExists(tx, billingAccountId);
      const resolvedVirtualKeyId =
        virtualKeyId ?? (await findDefaultKey(tx, billingAccountId)).id;

      const normalizedAmount = normalizeAmount(amount);
      const amountBigInt = BigInt(normalizedAmount);

      const [updatedAccount] = await tx
        .update(billingAccounts)
        .set({
          balanceCredits: sql`balance_credits + ${amountBigInt}`,
        })
        .where(eq(billingAccounts.id, billingAccountId))
        .returning({ balanceCredits: billingAccounts.balanceCredits });

      if (!updatedAccount) {
        throw new BillingAccountNotFoundPortError(billingAccountId);
      }

      const newBalance = toNumber(updatedAccount.balanceCredits);

      await tx.insert(creditLedger).values({
        id: ledgerEntryId,
        billingAccountId,
        virtualKeyId: resolvedVirtualKeyId,
        amount: amountBigInt,
        balanceAfter: updatedAccount.balanceCredits,
        reason,
        reference: reference ?? null,
        metadata: metadata ?? null,
      });

      committedAmount = amountBigInt;
      return { newBalance };
    });

    // CO_WRITE_NON_BLOCKING: TigerBeetle co-write AFTER Postgres tx commits.
    if (this.financialLedger && reason === "deposit" && committedAmount) {
      this.financialLedger
        .transfer({
          id: uuidToBigInt(ledgerEntryId),
          debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
          creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
          amount: committedAmount,
          ledger: LEDGER.CREDIT,
          code: TRANSFER_CODE.CREDIT_DEPOSIT,
          userData128: uuidToBigInt(ledgerEntryId),
        })
        .catch(() => {
          logger.error(
            {
              event: EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR,
              dep: "tigerbeetle",
              reasonCode: "co_write_credit_deposit",
              ledgerEntryId,
            },
            EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR
          );
        });
    }

    return result;
  }

  async listCreditLedgerEntries({
    billingAccountId,
    limit,
    reason,
  }: {
    billingAccountId: string;
    limit?: number | undefined;
    reason?: string | undefined;
  }): Promise<CreditLedgerEntry[]> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const where = reason
        ? and(
            eq(creditLedger.billingAccountId, billingAccountId),
            eq(creditLedger.reason, reason)
          )
        : eq(creditLedger.billingAccountId, billingAccountId);

      const rows = await tx.query.creditLedger.findMany({
        where,
        orderBy: (ledger, { desc: orderDesc }) => orderDesc(ledger.createdAt),
        ...(limit ? { limit } : {}),
      });

      return rows.map((row) => mapLedgerRow(row));
    });
  }

  async findCreditLedgerEntryByReference({
    billingAccountId,
    reason,
    reference,
  }: {
    billingAccountId: string;
    reason: string;
    reference: string;
  }): Promise<CreditLedgerEntry | null> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const entry = await tx.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.billingAccountId, billingAccountId),
          eq(creditLedger.reason, reason),
          eq(creditLedger.reference, reference)
        ),
        orderBy: (ledger, { desc: orderDesc }) => orderDesc(ledger.createdAt),
      });

      return entry ? mapLedgerRow(entry) : null;
    });
  }

  async listChargeReceipts(params: {
    billingAccountId: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      litellmCallId: string | null;
      chargedCredits: string;
      responseCostUsd: string | null;
      sourceSystem: SourceSystem;
      receiptKind: string;
      createdAt: Date;
    }>
  > {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const take = Math.min(params.limit ?? 100, 1000);

      const rows = await tx
        .select({
          id: chargeReceipts.id,
          litellmCallId: chargeReceipts.litellmCallId,
          chargedCredits: chargeReceipts.chargedCredits,
          responseCostUsd: chargeReceipts.responseCostUsd,
          sourceSystem: chargeReceipts.sourceSystem,
          receiptKind: chargeReceipts.receiptKind,
          createdAt: chargeReceipts.createdAt,
        })
        .from(chargeReceipts)
        .where(
          and(
            eq(chargeReceipts.billingAccountId, params.billingAccountId),
            gte(chargeReceipts.createdAt, params.from),
            lt(chargeReceipts.createdAt, params.to)
          )
        )
        .orderBy(desc(chargeReceipts.createdAt))
        .limit(take);

      return rows.map((r) => ({
        id: r.id,
        litellmCallId: r.litellmCallId,
        chargedCredits: String(r.chargedCredits),
        responseCostUsd: r.responseCostUsd ? String(r.responseCostUsd) : null,
        sourceSystem: r.sourceSystem as SourceSystem,
        receiptKind: r.receiptKind,
        createdAt: r.createdAt,
      }));
    });
  }

  async listLlmChargeDetails(params: {
    chargeReceiptIds: readonly string[];
  }): Promise<
    Array<{
      chargeReceiptId: string;
      providerCallId: string | null;
      model: string;
      provider: string | null;
      tokensIn: number | null;
      tokensOut: number | null;
      latencyMs: number | null;
      graphId: GraphId;
    }>
  > {
    if (params.chargeReceiptIds.length === 0) return [];

    return withTenantScope(this.db, this.actorId, async (tx) => {
      const rows = await tx
        .select()
        .from(llmChargeDetails)
        .where(
          inArray(llmChargeDetails.chargeReceiptId, [
            ...params.chargeReceiptIds,
          ])
        );

      return rows.map((r) => ({
        chargeReceiptId: r.chargeReceiptId,
        providerCallId: r.providerCallId,
        model: r.model,
        provider: r.provider,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        latencyMs: r.latencyMs,
        graphId: r.graphId as `${string}:${string}`,
      }));
    });
  }
}

// --- ServiceDrizzleAccountService (serviceDb, BYPASSRLS) ---

export class ServiceDrizzleAccountService implements ServiceAccountService {
  constructor(
    private readonly db: Database,
    private readonly financialLedger?: FinancialLedgerPort
  ) {}

  async getBillingAccountById(
    billingAccountId: string
  ): Promise<BillingAccount | null> {
    const account = await this.db.query.billingAccounts.findFirst({
      where: eq(billingAccounts.id, billingAccountId),
    });

    if (!account) {
      return null;
    }

    const defaultKey = await this.db.query.virtualKeys.findFirst({
      where: and(
        eq(virtualKeys.billingAccountId, billingAccountId),
        eq(virtualKeys.isDefault, true)
      ),
    });

    if (!defaultKey) {
      return null;
    }

    return {
      id: account.id,
      ownerUserId: account.ownerUserId,
      balanceCredits: toNumber(account.balanceCredits),
      defaultVirtualKeyId: defaultKey.id,
    };
  }

  async getOrCreateBillingAccountForUser({
    userId,
    displayName,
  }: {
    userId: string;
    walletAddress?: string;
    displayName?: string;
  }): Promise<BillingAccount> {
    if (!isValidUuid(userId)) {
      const dbFingerprint = getDbFingerprint(serverEnv().DATABASE_SERVICE_URL);
      throw new Error(
        `BUG: expected valid UUID v4 for owner_user_id, got: ${userId}. DB: ${dbFingerprint}`
      );
    }

    return await this.db.transaction(async (tx) => {
      const existingAccount = await tx.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, userId),
      });

      if (existingAccount) {
        const defaultKey = await findDefaultKey(tx, existingAccount.id);
        return {
          id: existingAccount.id,
          ownerUserId: existingAccount.ownerUserId,
          balanceCredits: toNumber(existingAccount.balanceCredits),
          defaultVirtualKeyId: defaultKey.id,
        };
      }

      const billingAccountId = randomUUID();

      await tx.insert(billingAccounts).values({
        id: billingAccountId,
        ownerUserId: userId,
        balanceCredits: 0n,
        // Display name intentionally optional; stored later when UX surfaces exist
      });

      const createdKey = await insertDefaultKey(
        tx,
        billingAccountId,
        displayName ? { label: displayName } : {}
      );

      return {
        id: billingAccountId,
        ownerUserId: userId,
        balanceCredits: 0,
        defaultVirtualKeyId: createdKey.id,
      };
    });
  }

  async creditAccount({
    billingAccountId,
    amount,
    reason,
    reference,
    virtualKeyId,
    metadata,
  }: {
    billingAccountId: string;
    amount: number;
    reason: string;
    reference?: string;
    virtualKeyId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ newBalance: number }> {
    const ledgerEntryId = randomUUID();
    let committedAmount: bigint | undefined;

    const result = await this.db.transaction(async (tx) => {
      await ensureBillingAccountExists(tx, billingAccountId);
      const resolvedVirtualKeyId =
        virtualKeyId ?? (await findDefaultKey(tx, billingAccountId)).id;

      const normalizedAmount = normalizeAmount(amount);
      const amountBigInt = BigInt(normalizedAmount);

      const [updatedAccount] = await tx
        .update(billingAccounts)
        .set({
          balanceCredits: sql`balance_credits + ${amountBigInt}`,
        })
        .where(eq(billingAccounts.id, billingAccountId))
        .returning({ balanceCredits: billingAccounts.balanceCredits });

      if (!updatedAccount) {
        throw new BillingAccountNotFoundPortError(billingAccountId);
      }

      const newBalance = toNumber(updatedAccount.balanceCredits);

      await tx.insert(creditLedger).values({
        id: ledgerEntryId,
        billingAccountId,
        virtualKeyId: resolvedVirtualKeyId,
        amount: amountBigInt,
        balanceAfter: updatedAccount.balanceCredits,
        reason,
        reference: reference ?? null,
        metadata: metadata ?? null,
      });

      committedAmount = amountBigInt;
      return { newBalance };
    });

    // CO_WRITE_NON_BLOCKING: TigerBeetle co-write AFTER Postgres tx commits.
    if (this.financialLedger && reason === "deposit" && committedAmount) {
      this.financialLedger
        .transfer({
          id: uuidToBigInt(ledgerEntryId),
          debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
          creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
          amount: committedAmount,
          ledger: LEDGER.CREDIT,
          code: TRANSFER_CODE.CREDIT_DEPOSIT,
          userData128: uuidToBigInt(ledgerEntryId),
        })
        .catch(() => {
          logger.error(
            {
              event: EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR,
              dep: "tigerbeetle",
              reasonCode: "co_write_credit_deposit",
              ledgerEntryId,
            },
            EVENT_NAMES.ADAPTER_TIGERBEETLE_ERROR
          );
        });
    }

    return result;
  }

  async findCreditLedgerEntryByReference({
    billingAccountId,
    reason,
    reference,
  }: {
    billingAccountId: string;
    reason: string;
    reference: string;
  }): Promise<CreditLedgerEntry | null> {
    const entry = await this.db.query.creditLedger.findFirst({
      where: and(
        eq(creditLedger.billingAccountId, billingAccountId),
        eq(creditLedger.reason, reason),
        eq(creditLedger.reference, reference)
      ),
      orderBy: (ledger, { desc: orderDesc }) => orderDesc(ledger.createdAt),
    });

    return entry ? mapLedgerRow(entry) : null;
  }
}
