// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/accounts`
 * Purpose: Billing account service port interface with charge receipt + llm_charge_details recording and port-level errors.
 * Scope: Defines contracts for billing account lifecycle, virtual key provisioning, and credit management. Does not implement business logic.
 * Invariants:
 * - All operations atomic; billing accounts own virtual keys; ledger integrity preserved
 * - charge receipts are idempotent by request_id
 * - ChargeReceiptParams requires explicit chargeReason, sourceSystem, sourceReference (no defaults)
 * - listChargeReceipts returns sourceSystem/sourceReference for generic linking (no litellmCallId)
 * Side-effects: none (interface definition only)
 * Notes: recordChargeReceipt is non-blocking (never throws InsufficientCredits post-call per ACTIVITY_METRICS.md)
 * Links: Implemented by DrizzleAccountService, used by completion feature and auth mapping, types/billing.ts (enums)
 * @public
 */

import type { GraphId } from "@cogni/ai-core";
import type { ChargeReason, SourceSystem } from "@cogni/node-core";

/**
 * Port-level error thrown by adapters when billing account has insufficient credits
 * Structured data for feature layer to translate into domain errors
 */
export class InsufficientCreditsPortError extends Error {
  constructor(
    public readonly billingAccountId: string,
    public readonly cost: number,
    public readonly previousBalance: number
  ) {
    super(
      `Insufficient credits: billing account ${billingAccountId} has ${previousBalance}, needs ${cost}`
    );
    this.name = "InsufficientCreditsPortError";
  }
}

/**
 * Port-level error thrown by adapters when billing account is not found
 */
export class BillingAccountNotFoundPortError extends Error {
  constructor(public readonly billingAccountId: string) {
    super(`Billing account not found: ${billingAccountId}`);
    this.name = "BillingAccountNotFoundPortError";
  }
}

/**
 * Port-level error thrown when a virtual key lookup fails for a billing account
 */
export class VirtualKeyNotFoundPortError extends Error {
  constructor(
    public readonly billingAccountId: string,
    public readonly virtualKeyId?: string
  ) {
    super(`Virtual key not found for billing account: ${billingAccountId}`);
    this.name = "VirtualKeyNotFoundPortError";
  }
}

/**
 * Type guard to check if error is InsufficientCreditsPortError
 */
export function isInsufficientCreditsPortError(
  error: unknown
): error is InsufficientCreditsPortError {
  return (
    error instanceof Error && error.name === "InsufficientCreditsPortError"
  );
}

/**
 * Type guard to check if error is BillingAccountNotFoundPortError
 */
export function isBillingAccountNotFoundPortError(
  error: unknown
): error is BillingAccountNotFoundPortError {
  return (
    error instanceof Error && error.name === "BillingAccountNotFoundPortError"
  );
}

/**
 * Type guard to check if error is VirtualKeyNotFoundPortError
 */
export function isVirtualKeyNotFoundPortError(
  error: unknown
): error is VirtualKeyNotFoundPortError {
  return error instanceof Error && error.name === "VirtualKeyNotFoundPortError";
}

export interface BillingAccount {
  id: string;
  ownerUserId: string;
  balanceCredits: number;
  defaultVirtualKeyId: string;
}

export interface CreditLedgerEntry {
  id: string;
  billingAccountId: string;
  virtualKeyId: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Provenance indicates how the charge receipt was generated.
 * - 'response': Non-streaming completion response
 * - 'stream': Streaming completion final result
 */
export type ChargeReceiptProvenance = "response" | "stream";

/**
 * Charge receipt params - minimal audit-focused fields per ACTIVITY_METRICS.md
 * No model/tokens/usage JSONB - LiteLLM is canonical for telemetry
 *
 * Per GRAPH_EXECUTION.md:
 * - runId: Canonical execution identity (groups multiple LLM calls)
 * - attempt: Retry attempt number (P0: always 0)
 * - sourceReference: Idempotency key = runId/attempt/usageUnitId
 * - ingressRequestId: Optional delivery-layer correlation (P0: equals runId; P1: many per runId)
 */
/** LLM-specific detail written to llm_charge_details alongside the charge receipt. */
export type LlmChargeDetail = {
  providerCallId: string | null;
  model: string;
  provider: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  graphId: GraphId;
};

export type ChargeReceiptParams = {
  billingAccountId: string;
  virtualKeyId: string;
  /** Canonical execution identity - groups all LLM calls in one graph execution */
  runId: string;
  /** Retry attempt number (P0: always 0; enables future retry semantics) */
  attempt: number;
  /** Ingress request correlation (optional, debug only). P0: equals runId; P1: many per runId (reconnect/resume) */
  ingressRequestId?: string;
  /** Credits debited from user balance */
  chargedCredits: bigint;
  /** Observational USD cost from LiteLLM (header or usage.cost) - null if unavailable */
  responseCostUsd: number | null;
  /** LiteLLM call ID for forensic correlation (x-litellm-call-id header) */
  litellmCallId: string | null;
  /** How this receipt was generated */
  provenance: ChargeReceiptProvenance;
  /** Economic/billing category for accounting and analytics */
  chargeReason: ChargeReason;
  /** External system that originated this charge */
  sourceSystem: SourceSystem;
  /** Idempotency key: runId/attempt/usageUnitId (unique per source_system) */
  sourceReference: string;
  /** Discriminator for detail table join (e.g. 'llm') */
  receiptKind: string;
  /** LLM-specific detail — written to llm_charge_details when receiptKind='llm' */
  llmDetail?: LlmChargeDetail;
};

/**
 * Strict subset of AccountService for service-role (BYPASSRLS) callers.
 * Exposes methods needed by auth mapping, internal routes, and system tenant operations.
 */
export interface ServiceAccountService {
  getBillingAccountById(
    billingAccountId: string
  ): Promise<BillingAccount | null>;

  getOrCreateBillingAccountForUser(params: {
    userId: string;
    walletAddress?: string;
    displayName?: string;
  }): Promise<BillingAccount>;

  /**
   * Credit billing account for system-level operations (e.g., revenue share bonus).
   * Uses BYPASSRLS — not scoped to a user's RLS context.
   */
  creditAccount(params: {
    billingAccountId: string;
    amount: number;
    reason: string;
    reference?: string;
    virtualKeyId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ newBalance: number }>;

  /**
   * Lookup a credit ledger entry by reference and reason for idempotency checks.
   * Uses BYPASSRLS — not scoped to a user's RLS context.
   */
  findCreditLedgerEntryByReference(params: {
    billingAccountId: string;
    reason: string;
    reference: string;
  }): Promise<CreditLedgerEntry | null>;
}

export interface AccountService {
  /**
   * Read-only lookup of billing account by ID.
   * Returns null if not found. Does not create.
   */
  getBillingAccountById(
    billingAccountId: string
  ): Promise<BillingAccount | null>;

  /**
   * Idempotently create or fetch a billing account for the given user.
   * Ensures a default virtual key exists and is returned for data-plane calls.
   */
  getOrCreateBillingAccountForUser(params: {
    userId: string;
    walletAddress?: string;
    displayName?: string;
  }): Promise<BillingAccount>;

  /**
   * Reads cached balance from billing_accounts table.
   * Not recomputed from ledger for performance.
   */
  getBalance(billingAccountId: string): Promise<number>;

  /**
   * Atomic credit deduction after LLM usage.
   * Prevents race conditions with single operation.
   * Throws InsufficientCreditsError if balance would go negative.
   */
  debitForUsage(params: {
    billingAccountId: string;
    virtualKeyId: string;
    cost: number;
    requestId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Credit billing account for funding/testing flows.
   * Inserts positive delta into ledger and returns new balance atomically.
   */
  creditAccount(params: {
    billingAccountId: string;
    amount: number;
    reason: string;
    reference?: string;
    virtualKeyId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ newBalance: number }>;

  /**
   * Fetch credit ledger entries for a billing account ordered by newest first.
   */
  listCreditLedgerEntries(params: {
    billingAccountId: string;
    limit?: number | undefined;
    reason?: string | undefined;
  }): Promise<CreditLedgerEntry[]>;

  /**
   * Records a charge receipt for an LLM call.
   * Atomic: writes charge_receipt + debits credit_ledger in transaction.
   * Idempotent: request_id as PK prevents duplicate inserts.
   *
   * INVARIANT: This method must NEVER throw InsufficientCreditsPortError.
   * Post-call billing is non-blocking per ACTIVITY_METRICS.md.
   * If balance goes negative, log critical but complete the write.
   */
  recordChargeReceipt(params: ChargeReceiptParams): Promise<void>;

  /**
   * Lookup a specific credit ledger entry by reference and reason for idempotency checks.
   */
  findCreditLedgerEntryByReference(params: {
    billingAccountId: string;
    reason: string;
    reference: string;
  }): Promise<CreditLedgerEntry | null>;

  /**
   * List charge receipts for a billing account.
   * Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: primary source for Activity dashboard.
   */
  listChargeReceipts(params: {
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
  >;

  /**
   * Fetch LLM charge details for a set of charge receipt IDs.
   * Used by Activity facade to enrich receipts with model/tokens.
   */
  listLlmChargeDetails(params: {
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
  >;
}
