// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema.billing`
 * Purpose: Billing tables schema with charge_receipts as ledger of truth and llm_charge_details for LLM telemetry.
 * Scope: Defines billing_accounts, virtual_keys, credit_ledger, charge_receipts, llm_charge_details, payment_attempts, payment_events. Does not include auth identity tables.
 * Invariants:
 * - Credits are BIGINT.
 * - billing_accounts.owner_user_id FK → auth.users(id).
 * - payment_attempts has partial unique index on (chain_id, tx_hash) where tx_hash is not null.
 * - credit_ledger(reference) is unique for widget_payment, charge_receipt, and platform_revenue_share.
 * - charge_receipts: UNIQUE(source_system, source_reference) for run-centric idempotency
 * - charge_receipts.request_id is NOT unique (multiple receipts per request allowed for graphs)
 * - charge_receipts has run_id, attempt columns for run-level queries
 * - charge_receipts uses (source_system, source_reference) for generic linking to external systems
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design, https://node-template.cognidao.org/knowledge/graph-execution-invariants, types/billing.ts
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts } from "./refs";

// Re-export for billing-focused imports
export { billingAccounts } from "./refs";

// Define enums locally to avoid src/ dependency
const CHARGE_REASONS = [
  "llm_usage",
  "image_generation",
  "subscription",
  "manual_adjustment",
  "promo_credit_consumption",
] as const;

const SOURCE_SYSTEMS = ["litellm", "anthropic_sdk", "codex", "ollama"] as const;

/**
 * Virtual keys table - scope/FK handle for billing attribution.
 * MVP: service-auth only (no per-user keys). When real API keys are introduced,
 * add key_hash column for hashed credentials.
 */
export const virtualKeys = pgTable("virtual_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  billingAccountId: text("billing_account_id")
    .notNull()
    .references(() => billingAccounts.id, { onDelete: "cascade" }),
  label: text("label").default("Default"),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    virtualKeyId: uuid("virtual_key_id")
      .notNull()
      .references(() => virtualKeys.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    reference: text("reference"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    referenceReasonIdx: index("credit_ledger_reference_reason_idx").on(
      table.reference,
      table.reason
    ),
    paymentRefUnique: uniqueIndex("credit_ledger_payment_ref_unique")
      .on(table.reference)
      .where(sql`${table.reason} = 'widget_payment'`),
    /** Idempotency guard for charge_receipt entries per ACTIVITY_METRICS.md */
    chargeReceiptRefUnique: uniqueIndex(
      "credit_ledger_charge_receipt_ref_unique"
    )
      .on(table.reference)
      .where(sql`${table.reason} = 'charge_receipt'`),
    /** Idempotency guard for revenue share bonus credits per system-tenant spec */
    revenueShareRefUnique: uniqueIndex("credit_ledger_revenue_share_ref_unique")
      .on(table.reference)
      .where(sql`${table.reason} = 'platform_revenue_share'`),
  })
).enableRLS();

/**
 * Charge receipts - minimal audit-focused table.
 * LiteLLM is canonical for telemetry (model/tokens). We only store billing data.
 * See https://node-template.cognidao.org/knowledge/graph-execution-invariants for design rationale.
 *
 * Per GRAPH_EXECUTION.md:
 * - run_id: Canonical execution identity (groups multiple LLM calls)
 * - attempt: Retry attempt number (P0: always 0)
 * - Idempotency: UNIQUE(source_system, source_reference) where source_reference = runId/attempt/usageUnitId
 * - ingress_request_id: Optional delivery correlation (debug only, never for idempotency)
 */
export const chargeReceipts = pgTable(
  "charge_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    virtualKeyId: uuid("virtual_key_id")
      .notNull()
      .references(() => virtualKeys.id, { onDelete: "cascade" }),
    /** Canonical execution identity - groups all LLM calls in one graph execution */
    runId: text("run_id").notNull(),
    /** Retry attempt number (P0: always 0; enables future retry semantics) */
    attempt: integer("attempt").notNull(),
    /** Ingress request correlation (nullable, debug only). P0: coincidentally equals runId; P1: many per runId */
    ingressRequestId: text("ingress_request_id"),
    /** LiteLLM call ID for forensic correlation (x-litellm-call-id header) */
    litellmCallId: text("litellm_call_id"),
    /** Credits debited from user balance */
    chargedCredits: bigint("charged_credits", { mode: "bigint" }).notNull(),
    /** Observational USD cost from LiteLLM (header or usage.cost) */
    responseCostUsd: numeric("response_cost_usd"),
    /** How this receipt was generated: 'response' | 'stream' */
    provenance: text("provenance").notNull(),
    /** Economic/billing category for accounting and analytics */
    chargeReason: text("charge_reason", { enum: CHARGE_REASONS }).notNull(),
    /** External system that originated this charge (e.g. 'litellm', 'anthropic_sdk') */
    sourceSystem: text("source_system", { enum: SOURCE_SYSTEMS }).notNull(),
    /** Idempotency key: runId/attempt/usageUnitId (unique per source_system) */
    sourceReference: text("source_reference").notNull(),
    /** Discriminator for detail table join (e.g. 'llm'). Required at write time, no default. */
    receiptKind: text("receipt_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    billingAccountIdx: index("charge_receipts_billing_account_idx").on(
      table.billingAccountId
    ),
    virtualKeyIdx: index("charge_receipts_virtual_key_idx").on(
      table.virtualKeyId
    ),
    // Index for aggregation: Filter by account + range scan on createdAt
    aggregationIdx: index("charge_receipts_aggregation_idx").on(
      table.billingAccountId,
      table.createdAt
    ),
    // Index for pagination: Filter by account + order by createdAt DESC, id DESC
    paginationIdx: index("charge_receipts_pagination_idx").on(
      table.billingAccountId,
      table.createdAt,
      table.id
    ),
    // Index for ingress request correlation (debug queries only)
    ingressRequestIdx: index("charge_receipts_ingress_request_idx").on(
      table.ingressRequestId
    ),
    // Index for run-level queries: Filter by run_id + attempt
    runAttemptIdx: index("charge_receipts_run_attempt_idx").on(
      table.runId,
      table.attempt
    ),
    // UNIQUE constraint for idempotency: (source_system, source_reference)
    sourceIdempotencyUnique: uniqueIndex(
      "charge_receipts_source_idempotency_unique"
    ).on(table.sourceSystem, table.sourceReference),
  })
).enableRLS();

/**
 * LLM-specific detail for charge receipts with receipt_kind='llm'.
 * 1:1 relationship: charge_receipt_id is both PK and FK.
 * Stores model, tokens, and provider telemetry captured at billing write time.
 */
export const llmChargeDetails = pgTable(
  "llm_charge_details",
  {
    chargeReceiptId: uuid("charge_receipt_id")
      .primaryKey()
      .references(() => chargeReceipts.id, { onDelete: "cascade" }),
    /** External provider call ID (e.g. x-litellm-call-id) for forensic correlation */
    providerCallId: text("provider_call_id"),
    /** LLM model used for this call */
    model: text("model").notNull(),
    /** Provider name (e.g. "openai", "anthropic") */
    provider: text("provider"),
    /** Input token count */
    tokensIn: integer("tokens_in"),
    /** Output token count */
    tokensOut: integer("tokens_out"),
    /** Call latency in milliseconds */
    latencyMs: integer("latency_ms"),
    /** Namespaced graph ID (e.g. 'langgraph:poet') or 'raw-completion' for direct calls */
    graphId: text("graph_id").notNull(),
  },
  (table) => [
    pgPolicy("tenant_isolation", {
      using: sql`EXISTS (
        SELECT 1 FROM charge_receipts cr
        JOIN billing_accounts ba ON ba.id = cr.billing_account_id
        WHERE cr.id = ${table.chargeReceiptId}
          AND ba.owner_user_id = current_setting('app.current_user_id', true)
      )`,
    }),
  ]
).enableRLS();

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    fromAddress: text("from_address").notNull(),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash"),
    token: text("token").notNull(),
    toAddress: text("to_address").notNull(),
    amountRaw: bigint("amount_raw", { mode: "bigint" }).notNull(),
    amountUsdCents: integer("amount_usd_cents").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    lastVerifyAttemptAt: timestamp("last_verify_attempt_at", {
      withTimezone: true,
    }),
    verifyAttemptCount: integer("verify_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chainTxUnique: uniqueIndex("payment_attempts_chain_tx_unique")
      .on(table.chainId, table.txHash)
      .where(sql`${table.txHash} IS NOT NULL`),
    billingAccountIdx: index("payment_attempts_billing_account_idx").on(
      table.billingAccountId,
      table.createdAt
    ),
    statusIdx: index("payment_attempts_status_idx").on(
      table.status,
      table.createdAt
    ),
  })
).enableRLS();

/**
 * Provider funding attempts — durable state for crash recovery of provider top-ups.
 * Keyed by paymentIntentId (one-to-one with credit purchase).
 * Status machine: pending → charge_created → funded | failed
 * Per task.0086: DURABLE_FUNDING_ROW invariant.
 */
export const providerFundingAttempts = pgTable(
  "provider_funding_attempts",
  {
    id: uuid("id").primaryKey(), // deterministic from paymentIntentId
    paymentIntentId: text("payment_intent_id").notNull().unique(),
    status: text("status").notNull().default("pending"), // pending | charge_created | funded | failed
    provider: text("provider").notNull().default("openrouter"),
    chargeId: text("charge_id"),
    chargeExpiresAt: timestamp("charge_expires_at", { withTimezone: true }),
    amountUsdcMicro: bigint("amount_usdc_micro", { mode: "bigint" }),
    fundingTxHash: text("funding_tx_hash"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index("provider_funding_attempts_status_idx").on(
      table.status,
      table.createdAt
    ),
  })
).enableRLS();

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    errorCode: text("error_code"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    attemptIdx: index("payment_events_attempt_idx").on(
      table.attemptId,
      table.createdAt
    ),
  })
).enableRLS();
