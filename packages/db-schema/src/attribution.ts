// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/attribution`
 * Purpose: Five-stage epoch ledger schema for auditable activity-based credit distribution.
 * Scope: Defines all ledger tables (epochs, ingestion_receipts, epoch_selection, epoch_user_projections, epoch_evaluations, ingestion_cursors, epoch_pool_components, epoch_review_subject_overrides, epoch_final_claimant_allocations, epoch_statements, epoch_statement_signatures, epoch_distribution_manifests, epoch_distribution_leaves). Does not contain queries, business logic, or I/O.
 * Invariants:
 * - All credit/unit columns use BIGINT (ALL_MATH_BIGINT).
 * - Ingestion layer (ingestion_receipts, epoch_pool_components) are append-only (DB triggers in migration).
 * - Selection layer (epoch_selection) is mutable while epoch open/review, frozen on finalize (SELECTION_FREEZE_ON_FINALIZE).
 * - ONE_OPEN_EPOCH: partial unique index on epochs WHERE status = 'open', scoped to (node_id, scope_id).
 * - EPOCH_WINDOW_UNIQUE: unique(node_id, scope_id, period_start, period_end).
 * - NODE_SCOPED: all ledger tables include node_id.
 * - RECEIPT_SCOPE_AGNOSTIC: ingestion_receipts has no scope_id — scope assigned at selection via epoch membership.
 * - EVALUATION_UNIQUE_PER_REF_STATUS: UNIQUE(epoch_id, evaluation_ref, status) — one draft + one locked per ref.
 * - EVALUATION_FINAL_ATOMIC: locked evaluation writes + artifacts_hash + epoch open→review in one transaction (enforced in store).
 * - RLS deny-all on the user-FK ledger tables (epoch_selection, epoch_user_projections):
 *   ENABLE + FORCE with no policy (migration 0032). All access is via the BYPASSRLS
 *   service-role worker; there is no app-role read path. See docs/spec/database-rls.md (RLS_COVERAGE).
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/attribution-ledger.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./refs";

// ---------------------------------------------------------------------------
// Epochs — Layer 0 (time boundaries + config)
// ---------------------------------------------------------------------------

/**
 * Epochs — one open epoch at a time per node (ONE_OPEN_EPOCH).
 * node_id scoped (NODE_SCOPED).
 */
export const epochs = pgTable(
  "epochs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    nodeId: uuid("node_id").notNull(),
    scopeId: uuid("scope_id").notNull(),
    status: text("status").notNull().default("open"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    weightConfig: jsonb("weight_config")
      .$type<Record<string, number>>()
      .notNull(),
    poolTotalCredits: bigint("pool_total_credits", { mode: "bigint" }),
    approverSetHash: text("approver_set_hash"),
    approvers: jsonb("approvers").$type<string[]>(),
    allocationAlgoRef: text("allocation_algo_ref"),
    weightConfigHash: text("weight_config_hash"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    artifactsHash: text("artifacts_hash"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "epochs_status_check",
      sql`${table.status} IN ('open', 'review', 'finalized')`
    ),
    // EPOCH_WINDOW_UNIQUE: no overlapping windows per node+scope
    uniqueIndex("epochs_window_unique").on(
      table.nodeId,
      table.scopeId,
      table.periodStart,
      table.periodEnd
    ),
    // ONE_OPEN_EPOCH per node+scope
    uniqueIndex("epochs_one_open_per_node")
      .on(table.nodeId, table.scopeId, table.status)
      .where(sql`${table.status} = 'open'`),
  ]
);

// ---------------------------------------------------------------------------
// Ingestion Layer: Raw Receipts (immutable always)
// ---------------------------------------------------------------------------

/**
 * Ingestion receipts — immutable facts, append-only (RECEIPT_APPEND_ONLY).
 * DB trigger rejects UPDATE/DELETE.
 * No user_id — identity resolution happens at selection layer.
 * No epoch_id — epoch membership derived from event_time at selection layer.
 * No scope_id — receipts are scope-agnostic global facts (RECEIPT_SCOPE_AGNOSTIC).
 * Composite PK: (node_id, receipt_id) where receipt_id is deterministic (e.g., "github:pr:org/repo:42").
 */
export const ingestionReceipts = pgTable(
  "ingestion_receipts",
  {
    nodeId: uuid("node_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    platformLogin: text("platform_login"),
    artifactUrl: text("artifact_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    payloadHash: text("payload_hash").notNull(),
    producer: text("producer").notNull(),
    producerVersion: text("producer_version").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.receiptId] }),
    index("ingestion_receipts_node_time_idx").on(table.nodeId, table.eventTime),
    index("ingestion_receipts_source_type_idx").on(
      table.source,
      table.eventType
    ),
    index("ingestion_receipts_platform_user_idx").on(table.platformUserId),
  ]
);

// ---------------------------------------------------------------------------
// Selection Layer: Epoch membership + admin decisions (mutable until finalize)
// ---------------------------------------------------------------------------

/**
 * Epoch selection — admin decisions about which receipts count and how.
 * Mutable while epoch is open or review, frozen by trigger when epoch finalizes (SELECTION_FREEZE_ON_FINALIZE).
 * Links receipts to epochs (epoch membership assigned here, not on raw receipt).
 */
export const epochSelection = pgTable(
  "epoch_selection",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    receiptId: text("receipt_id").notNull(),
    userId: text("user_id").references(() => users.id),
    included: boolean("included").notNull().default(true),
    weightOverrideMilli: bigint("weight_override_milli", { mode: "bigint" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_selection_epoch_receipt_unique").on(
      table.epochId,
      table.receiptId
    ),
    index("epoch_selection_epoch_idx").on(table.epochId),
  ]
);

// ---------------------------------------------------------------------------
// User projections (computed from selection)
// ---------------------------------------------------------------------------

/**
 * Epoch user projections — per-user tentative units for an epoch.
 * Projection only: canonical signed units live in epoch_final_claimant_allocations.
 */
export const epochUserProjections = pgTable(
  "epoch_user_projections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    projectedUnits: bigint("projected_units", { mode: "bigint" }).notNull(),
    receiptCount: integer("receipt_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_user_projections_epoch_user_unique").on(
      table.epochId,
      table.userId
    ),
    index("epoch_user_projections_epoch_idx").on(table.epochId),
  ]
);

// ---------------------------------------------------------------------------
// Ingestion cursors (ingestion state tracking)
// ---------------------------------------------------------------------------

/**
 * Ingestion cursors — track ingestion position per source stream.
 * Composite PK: (node_id, scope_id, source, stream, source_ref).
 * Cursors remain scope-scoped — scoped collection is fine because receipt inserts are idempotent.
 */
export const ingestionCursors = pgTable(
  "ingestion_cursors",
  {
    nodeId: uuid("node_id").notNull(),
    scopeId: uuid("scope_id").notNull(),
    source: text("source").notNull(),
    stream: text("stream").notNull(),
    sourceRef: text("source_ref").notNull(),
    cursorValue: text("cursor_value").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.nodeId,
        table.scopeId,
        table.source,
        table.stream,
        table.sourceRef,
      ],
    }),
  ]
);

// ---------------------------------------------------------------------------
// Epoch pool components (immutable, append-only)
// ---------------------------------------------------------------------------

/**
 * Epoch pool components — immutable, append-only (POOL_IMMUTABLE).
 * DB trigger rejects UPDATE/DELETE.
 * POOL_UNIQUE_PER_TYPE: UNIQUE(epoch_id, component_id).
 */
export const epochPoolComponents = pgTable(
  "epoch_pool_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    componentId: text("component_id").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    inputsJson: jsonb("inputs_json").$type<Record<string, unknown>>().notNull(),
    amountCredits: bigint("amount_credits", { mode: "bigint" }).notNull(),
    evidenceRef: text("evidence_ref"),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_pool_components_epoch_component_unique").on(
      table.epochId,
      table.componentId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Receipt Claimants — per-receipt ownership resolution (draft/locked lifecycle)
// ---------------------------------------------------------------------------

/**
 * Epoch receipt claimants — per-receipt ownership records.
 * Draft rows written during materializeSelection / enrichment. Locked at closeIngestion.
 * One draft per (node_id, epoch_id, receipt_id). One locked snapshot per receipt.
 * CLAIMANTS_TABLE_NODE_SCOPED: all uniques/indexes include node_id.
 */
export const epochReceiptClaimants = pgTable(
  "epoch_receipt_claimants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    receiptId: text("receipt_id").notNull(),
    status: text("status").notNull().default("draft"),
    resolverRef: text("resolver_ref").notNull(),
    algoRef: text("algo_ref").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    claimantsJson: jsonb("claimants_json").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => [
    check(
      "epoch_receipt_claimants_status_check",
      sql`${table.status} IN ('draft', 'locked')`
    ),
    // One draft per receipt per epoch per tenant (upsert overwrites)
    uniqueIndex("epoch_receipt_claimants_draft_uniq")
      .on(table.nodeId, table.epochId, table.receiptId)
      .where(sql`${table.status} = 'draft'`),
    // Exactly one locked snapshot per receipt per epoch per tenant
    uniqueIndex("epoch_receipt_claimants_locked_uniq")
      .on(table.nodeId, table.epochId, table.receiptId)
      .where(sql`${table.status} = 'locked'`),
    // Idempotency: same inputs → same row
    uniqueIndex("epoch_receipt_claimants_inputs_uniq").on(
      table.nodeId,
      table.epochId,
      table.receiptId,
      table.inputsHash
    ),
    // Allocation reads: all locked rows for an epoch
    index("epoch_receipt_claimants_epoch_status_idx").on(
      table.nodeId,
      table.epochId,
      table.status
    ),
  ]
);

// ---------------------------------------------------------------------------
// Evaluation Layer: Enrichment outputs (draft/locked lifecycle)
// ---------------------------------------------------------------------------

/**
 * Epoch evaluations — typed enrichment outputs for scoring pipeline.
 * EVALUATION_UNIQUE_PER_REF_STATUS: one draft + one locked row per evaluation_ref per epoch.
 * Drafts overwritten via UPSERT each collection pass. Locked evaluations written once at closeIngestion.
 * EVALUATION_LOCKED_IMMUTABLE: DB trigger rejects UPDATE/DELETE when status='locked'.
 */
export const epochEvaluations = pgTable(
  "epoch_evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    evaluationRef: text("evaluation_ref").notNull(),
    status: text("status").notNull().default("draft"),
    algoRef: text("algo_ref").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    payloadRef: text("payload_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_evaluations_ref_status_unique").on(
      table.epochId,
      table.evaluationRef,
      table.status
    ),
    check(
      "epoch_evaluations_status_check",
      sql`${table.status} IN ('draft', 'locked')`
    ),
    check(
      "epoch_evaluations_payload_check",
      sql`${table.payloadJson} IS NOT NULL OR ${table.payloadRef} IS NOT NULL`
    ),
    index("epoch_evaluations_epoch_idx").on(table.epochId),
  ]
);

// ---------------------------------------------------------------------------
// Subject Overrides: Review-phase per-subject adjustments (mutable until finalize)
// ---------------------------------------------------------------------------

/**
 * Epoch review subject overrides — per-subject absolute review overrides.
 * Mutable while epoch is in review status. Snapshot into statement at finalization.
 * UNIQUE(epoch_id, subject_ref) — one override per subject per epoch.
 */
export const epochReviewSubjectOverrides = pgTable(
  "epoch_review_subject_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    subjectRef: text("subject_ref").notNull(),
    overrideUnits: bigint("override_units", { mode: "bigint" }),
    overrideSharesJson: jsonb("override_shares_json").$type<
      Array<{
        claimant:
          | { kind: "user"; userId: string }
          | {
              kind: "identity";
              provider: string;
              externalId: string;
              providerLogin: string | null;
            };
        sharePpm: number;
      }>
    >(),
    overrideReason: text("override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_review_subject_overrides_epoch_ref_unique").on(
      table.epochId,
      table.subjectRef
    ),
    index("epoch_review_subject_overrides_epoch_idx").on(table.epochId),
  ]
);

// ---------------------------------------------------------------------------
// Finalization Layer: Final claimant allocations + statements + signatures
// ---------------------------------------------------------------------------

/**
 * Epoch final claimant allocations — canonical signed units per claimant.
 * Materialized atomically with statement/signature on finalization.
 */
export const epochFinalClaimantAllocations = pgTable(
  "epoch_final_claimant_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    claimantKey: text("claimant_key").notNull(),
    claimantJson: jsonb("claimant_json")
      .$type<
        | { kind: "user"; userId: string }
        | {
            kind: "identity";
            provider: string;
            externalId: string;
            providerLogin: string | null;
          }
      >()
      .notNull(),
    finalUnits: bigint("final_units", { mode: "bigint" }).notNull(),
    receiptIdsJson: jsonb("receipt_ids_json").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_final_claimant_allocations_epoch_claimant_unique").on(
      table.epochId,
      table.claimantKey
    ),
    index("epoch_final_claimant_allocations_epoch_idx").on(table.epochId),
  ]
);

// ---------------------------------------------------------------------------
// Finalization Layer: Statements + Signatures (immutable once signed)
// ---------------------------------------------------------------------------

/**
 * Epoch statements — deterministic distribution plan from receipts + selection + pool + weights.
 * One per epoch (scoped to node). Amendments use supersedes_statement_id.
 * Note: "statement" = entitlement plan. Future settlement/payout layer will reference these.
 */
export const epochStatements = pgTable(
  "epoch_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    finalAllocationSetHash: text("final_allocation_set_hash").notNull(),
    poolTotalCredits: bigint("pool_total_credits", {
      mode: "bigint",
    }).notNull(),
    statementLinesJson: jsonb("statement_lines_json")
      .$type<
        Array<{
          claimant_key: string;
          claimant:
            | { kind: "user"; userId: string }
            | {
                kind: "identity";
                provider: string;
                externalId: string;
                providerLogin: string | null;
              };
          final_units: string;
          pool_share: string;
          credit_amount: string;
          receipt_ids: string[];
        }>
      >()
      .notNull(),
    reviewOverridesJson: jsonb("review_overrides_json").$type<
      Array<{
        subject_ref: string;
        original_units: string;
        override_units: string | null;
        original_shares: Array<{
          claimant:
            | { kind: "user"; userId: string }
            | {
                kind: "identity";
                provider: string;
                externalId: string;
                providerLogin: string | null;
              };
          sharePpm: number;
        }>;
        override_shares: Array<{
          claimant:
            | { kind: "user"; userId: string }
            | {
                kind: "identity";
                provider: string;
                externalId: string;
                providerLogin: string | null;
              };
          sharePpm: number;
        }> | null;
        reason: string | null;
      }>
    >(),
    supersedesStatementId: uuid("supersedes_statement_id").references(
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle self-referencing FK requires explicit type to break circular inference
      (): any => epochStatements.id
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("epoch_statements_node_epoch_unique").on(
      table.nodeId,
      table.epochId
    ),
  ]
);

/**
 * Epoch statement signatures — client-side EIP-191 signatures on epoch statements.
 */
export const epochStatementSignatures = pgTable(
  "epoch_statement_signatures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => epochStatements.id),
    signerWallet: text("signer_wallet").notNull(),
    signature: text("signature").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("epoch_statement_signatures_statement_signer_unique").on(
      table.statementId,
      table.signerWallet
    ),
  ]
);

// ---------------------------------------------------------------------------
// Distribution Layer: Merkle distribution manifest + leaves (DAO token claims)
// ---------------------------------------------------------------------------

/**
 * Epoch distribution manifests — persisted `DaoTokenMerkleDistribution` headers.
 * One per epoch (scoped to node+scope), keyed (node_id, scope_id, epoch_id).
 * Stores the merkle root, the on-chain claim parameters (chain_id, token_address,
 * distribution_amount), and the statement_hash lineage that the manifest was built
 * from (DISTRIBUTION_STATEMENT_LINEAGE). distributor_address is NULL until the
 * MerkleDistributor contract is deployed for this epoch.
 * Per-leaf {index, account, amount, proof[]} rows live in epoch_distribution_leaves.
 * No FK to users — leaves are keyed by EVM account address, not a user UUID.
 */
export const epochDistributionManifests = pgTable(
  "epoch_distribution_manifests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    scopeId: uuid("scope_id").notNull(),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    distributionId: text("distribution_id").notNull(),
    statementHash: text("statement_hash").notNull(),
    merkleRoot: text("merkle_root").notNull(),
    chainId: bigint("chain_id", { mode: "bigint" }).notNull(),
    tokenAddress: text("token_address").notNull(),
    distributionAmount: bigint("distribution_amount", {
      mode: "bigint",
    }).notNull(),
    totalAllocated: bigint("total_allocated", { mode: "bigint" }).notNull(),
    // NULL until the on-chain MerkleDistributor contract is deployed for this epoch.
    distributorAddress: text("distributor_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One manifest per epoch per tenant scope (DISTRIBUTION_ONE_PER_EPOCH).
    uniqueIndex("epoch_distribution_manifests_node_scope_epoch_unique").on(
      table.nodeId,
      table.scopeId,
      table.epochId
    ),
    index("epoch_distribution_manifests_epoch_idx").on(table.epochId),
  ]
);

/**
 * Epoch distribution leaves — per-claimant merkle leaf + proof.
 * One row per leaf in the manifest's merkle tree. account is an EVM address
 * (lowercased into account_lower for case-insensitive claimant lookup). amount is
 * the ERC20 base-unit claim amount; proof_json is the ordered sibling-hash array
 * the claim contract verifies against merkle_root.
 */
export const epochDistributionLeaves = pgTable(
  "epoch_distribution_leaves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id").notNull(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => epochDistributionManifests.id, { onDelete: "cascade" }),
    epochId: bigint("epoch_id", { mode: "bigint" })
      .notNull()
      .references(() => epochs.id),
    leafIndex: integer("leaf_index").notNull(),
    claimantKey: text("claimant_key").notNull(),
    account: text("account").notNull(),
    accountLower: text("account_lower").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    leafHash: text("leaf_hash").notNull(),
    proofJson: jsonb("proof_json").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One leaf per index per manifest.
    uniqueIndex("epoch_distribution_leaves_manifest_index_unique").on(
      table.manifestId,
      table.leafIndex
    ),
    // Claimant proof lookup by (manifest, lowercased account).
    uniqueIndex("epoch_distribution_leaves_manifest_account_unique").on(
      table.manifestId,
      table.accountLower
    ),
    index("epoch_distribution_leaves_epoch_idx").on(table.epochId),
  ]
);
