// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/billing`
 * Purpose: Post-call charge recording (non-blocking) and run-centric billing via commitUsageFact.
 * Scope: Calculate user charge from provider cost, record charge receipt. Does NOT perform pre-flight checks or LLM calls.
 * Invariants:
 *   - ONE_LEDGER_WRITER: Only this module calls accountService.recordChargeReceipt()
 *   - BILLING_NEVER_THROWS: Post-call billing NEVER blocks user response or throws (catches all errors, logs)
 *   - COST_AUTHORITY_IS_LITELLM: All LLM cost/tokens used for billing originate from LiteLLM (callback or spend/logs). App code never infers cost.
 *   - RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST: A receipt is written iff usageUnitId exists AND costUsd is a number (0 allowed). Missing cost never writes.
 *   - NO_PLACEHOLDER_RECEIPTS: Never write $0/empty receipts as placeholders for non-free calls. Defer until authoritative cost arrives.
 *   - IDEMPOTENCY_KEY_IS_LITELLM_CALL_ID: source_reference = runId/attempt/usageUnitId; DB constraint prevents duplicates
 * Side-effects: IO (writes charge receipt via AccountService)
 * Notes: Per GRAPH_EXECUTION.md, COMPLETION_REFACTOR_PLAN.md P2 extraction
 * Links: completion.ts, ports/account.port.ts, llmPricingPolicy.ts, GRAPH_EXECUTION.md
 * @public
 */

import type { RunContext, UsageFact } from "@cogni/node-core";
import type { AiBillingCommitCompleteEvent } from "@cogni/node-shared";
import type { Logger } from "pino";
import type { AccountService } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";
import {
  billingInvariantViolationTotal,
  billingMissingCostDeferredTotal,
} from "@/shared/observability/server/metrics";
import { calculateDefaultLlmCharge } from "./llmPricingPolicy";

// ============================================================================
// Run-Centric Billing (GRAPH_EXECUTION.md P0)
// ============================================================================

/**
 * Compute idempotency key for run-centric billing.
 * Per GRAPH_EXECUTION.md: source_reference = runId/attempt/usageUnitId
 *
 * @param runId - Graph run ID
 * @param attempt - Attempt number (P0: always 0)
 * @param usageUnitId - Adapter-provided stable ID for this usage unit
 * @returns Idempotency key for source_reference column
 */
export function computeIdempotencyKey(
  runId: string,
  attempt: number,
  usageUnitId: string
): string {
  return `${runId}/${attempt}/${usageUnitId}`;
}

/**
 * Commit a usage fact to the billing ledger.
 * Per GRAPH_EXECUTION.md: billing subscriber calls this for each usage_report event.
 *
 * Invariants:
 * - ONE_LEDGER_WRITER: Only this module calls accountService.recordChargeReceipt()
 * - IDEMPOTENT_CHARGES: DB constraint on (source_system, source_reference) prevents duplicates
 * - Billing subscriber owns callIndex for deterministic fallback
 * - RELAY_PROVIDES_CONTEXT: ingressRequestId comes from context, not from fact
 *
 * @param fact - Usage fact from usage_report event (executor-agnostic)
 * @param callIndex - Billing-subscriber-assigned index for fallback usageUnitId
 * @param context - Run context from relay (provides ingressRequestId for correlation)
 * @param accountService - Account service port for charge recording
 * @param log - Logger for error reporting
 */
export async function commitUsageFact(
  fact: UsageFact,
  context: RunContext,
  accountService: AccountService,
  log: Logger
): Promise<void> {
  const {
    runId,
    attempt,
    billingAccountId,
    virtualKeyId,
    source,
    usageUnitId,
  } = fact;
  const { ingressRequestId } = context;

  // External executors (validated with hints schema) may have undefined usageUnitId.
  // Billing-authoritative executors (strict schema) always have usageUnitId (validation ensures it).
  if (!usageUnitId) {
    // Skip billing for external executor hints without usageUnitId (telemetry-only, not authoritative)
    log.warn(
      { runId, executorType: fact.executorType },
      "Skipping billing commit: usageUnitId missing (external executor hint)"
    );
    return;
  }

  if (!billingAccountId || !virtualKeyId) {
    billingInvariantViolationTotal.inc({
      type: "missing_billing_identity",
    });
    log.error(
      { runId, executorType: fact.executorType, fact },
      "Skipping billing commit: billing identity missing from usage fact"
    );
    return;
  }

  try {
    // COST_AUTHORITY_IS_LITELLM: costUsd must be provided by LiteLLM (0 allowed)
    const model = fact.model ?? "unknown";
    const costUsd = fact.costUsd;

    if (typeof costUsd !== "number") {
      // Cost unknown — defer or error based on source
      if (source === "litellm") {
        // DEFER: callback-backed — callback/reconciler will supply cost
        billingMissingCostDeferredTotal.inc({ source_system: source });
        log.debug(
          { runId, ingressRequestId, model, usageUnitId, source },
          "Cost unknown — deferring to LiteLLM callback (no receipt written)"
        );
      } else {
        // Invariant violation: non-litellm source with unknown cost
        billingInvariantViolationTotal.inc({
          type: "non_litellm_unknown_cost",
        });
        log.error(
          { runId, ingressRequestId, model, usageUnitId, source },
          "Invariant violation: non-litellm source with unknown cost in commitUsageFact"
        );
      }
      return;
    }

    // RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST: cost known — calculate charge, write receipt
    const { chargedCredits, userCostUsd } = calculateDefaultLlmCharge(costUsd);

    log.debug(
      {
        runId,
        ingressRequestId,
        providerCostUsd: costUsd,
        userCostUsd,
        chargedCredits: chargedCredits.toString(),
      },
      "commitUsageFact: cost calculation complete"
    );

    // Compute idempotency key
    const sourceReference = computeIdempotencyKey(runId, attempt, usageUnitId);

    // Record charge receipt (sole ledger writer)
    await accountService.recordChargeReceipt({
      billingAccountId,
      virtualKeyId,
      runId,
      attempt,
      ...(ingressRequestId && { ingressRequestId }), // Optional delivery correlation
      chargedCredits,
      responseCostUsd: userCostUsd,
      litellmCallId: fact.usageUnitId ?? null, // Original adapter ID for correlation
      provenance: "stream", // Graph execution always streams
      chargeReason: "llm_usage",
      sourceSystem: source,
      sourceReference,
      receiptKind: "llm",
      llmDetail: {
        providerCallId: fact.usageUnitId ?? null,
        model,
        provider: fact.provider ?? null,
        tokensIn: fact.inputTokens ?? null,
        tokensOut: fact.outputTokens ?? null,
        latencyMs: null, // Not available in UsageFact
        graphId: fact.graphId,
      },
    });

    // Log billing commit complete (success path)
    const successEvent: AiBillingCommitCompleteEvent = {
      event: EVENT_NAMES.AI_BILLING_COMMIT_COMPLETE,
      reqId: ingressRequestId,
      runId,
      attempt,
      outcome: "success",
      chargedCredits: chargedCredits.toString(),
      sourceSystem: source,
    };
    log.info(successEvent);
  } catch (error) {
    // Post-call billing is best-effort - NEVER block user response
    // Log billing commit complete (error path) with errorCode
    const errorCode =
      error instanceof Error && error.message.includes("duplicate")
        ? "db_error"
        : "unknown";
    const errorEvent: AiBillingCommitCompleteEvent = {
      event: EVENT_NAMES.AI_BILLING_COMMIT_COMPLETE,
      reqId: ingressRequestId,
      runId,
      attempt,
      outcome: "error",
      errorCode,
      sourceSystem: source,
    };
    log.error({ ...errorEvent, err: error });
  }
}
