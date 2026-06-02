// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/schema`
 * Purpose: Zod schemas and derived types for .cogni/repo-spec.yaml validation.
 * Scope: Validates governance-managed payment, governance schedule, and activity ledger configuration structures. Does not enforce chain/token values (chain validation happens in accessor layer via chainId parameter).
 * Invariants: EVM address format required; activity sources require source_refs. REPO_SPEC_AUTHORITY — single canonical schema definition.
 * Side-effects: none
 * Links: .cogni/repo-spec.yaml, docs/spec/node-operator-contract.md
 * @public
 */

import { z } from "zod";

/**
 * Schema for payments_in.credits_topup configuration.
 * Validates inbound payment settings structure.
 */
export const creditsTopupSpecSchema = z.object({
  /** Payment provider identifier (e.g., "cogni-usdc-backend-v1") */
  provider: z.string().min(1, "Provider must be a non-empty string"),

  /** EVM address receiving inbound payments (DAO wallet) */
  receiving_address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Receiving address must be a valid EVM address (0x + 40 hex chars)"
    ),

  /** Optional: Informational list of chain names (not enforced by schema) */
  allowed_chains: z.array(z.string()).optional(),

  /** Optional: Informational list of token names (not enforced by schema) */
  allowed_tokens: z.array(z.string()).optional(),
});

export type CreditsTopupSpec = z.infer<typeof creditsTopupSpecSchema>;

/**
 * Schema for a single governance schedule entry.
 * Each schedule triggers a sandbox agent run with a 1-word entrypoint.
 * Invariants: Charter must be unique per config; cron must be 5 fields; entrypoint must be 1 token (no spaces).
 */
export const governanceScheduleSchema = z.object({
  /** Charter name (e.g., COMMUNITY, ENGINEERING, SUSTAINABILITY, GOVERN) */
  charter: z.string().min(1, "Charter must be non-empty"),
  /** 5-field cron expression (minute hour day month weekday) */
  cron: z
    .string()
    .regex(
      /^(\S+\s+){4}\S+$/,
      "Cron must be a 5-field expression (minute hour day month weekday)"
    ),
  /** IANA timezone (defaults to UTC) */
  timezone: z.string().default("UTC"),
  /** Trigger word sent to the sandbox agent (single token, no spaces) */
  entrypoint: z
    .string()
    .regex(/^\S+$/, "Entrypoint must be a single token (no spaces)"),
});

export type GovernanceScheduleSpec = z.infer<typeof governanceScheduleSchema>;

/**
 * Schema for the governance section of repo-spec.
 * Optional — existing deployments without this section continue to work.
 */
export const governanceSpecSchema = z.object({
  schedules: z
    .array(governanceScheduleSchema)
    .default([])
    .refine(
      (arr) =>
        new Set(arr.map((s) => s.charter.toLowerCase())).size === arr.length,
      { message: "Duplicate charter names in governance.schedules" }
    ),
});

export type GovernanceSpec = z.infer<typeof governanceSpecSchema>;

/**
 * Schema for activity_ledger section — epoch and ingestion configuration.
 */
export const activitySourceSpecSchema = z.object({
  /** Attribution pipeline profile ID (e.g., "cogni-v0.0") */
  attribution_pipeline: z.string().min(1),
  /** External namespaces for cursor scoping (e.g., repo slugs) */
  source_refs: z.array(z.string().min(1)).min(1),
  /** Platform logins to exclude from attribution (e.g., automation bots) */
  excluded_logins: z.array(z.string().min(1)).optional(),
});

export type ActivitySourceSpec = z.infer<typeof activitySourceSpecSchema>;

/**
 * Schema for pool_config — governance-managed pool budget parameters.
 */
export const poolConfigSpecSchema = z.object({
  /** Base issuance in credits (string → bigint). Governance-set budget per epoch. */
  base_issuance_credits: z
    .string()
    .min(1, "base_issuance_credits must be a non-empty string"),
});

export type PoolConfigSpec = z.infer<typeof poolConfigSpecSchema>;

export const activityLedgerSpecSchema = z.object({
  /** Epoch length in days (1–90) */
  epoch_length_days: z.number().int().min(1).max(90),
  /** EVM addresses allowed to mutate ledger data (allocations, pool components) */
  approvers: z
    .array(
      z
        .string()
        .regex(
          /^0x[a-fA-F0-9]{40}$/,
          "Each approver must be a valid EVM address (0x + 40 hex chars)"
        )
    )
    .default([]),
  /** Map of source name → source config */
  activity_sources: z.record(z.string(), activitySourceSpecSchema),
  /** Pool budget configuration (optional — defaults to 0 base issuance if missing) */
  pool_config: poolConfigSpecSchema.optional(),
});

export type ActivityLedgerSpec = z.infer<typeof activityLedgerSpecSchema>;

/**
 * Schema for operator_wallet configuration.
 * Privy-managed operator wallet address — governance-in-git.
 * The Split contract address lives in payments_in.credits_topup.receiving_address
 * (single source of truth for where user payments land).
 */
export const operatorWalletSpecSchema = z.object({
  /** Checksummed EVM address of the Privy-managed operator wallet */
  address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Operator wallet address must be a valid EVM address (0x + 40 hex chars)"
    ),
});

export type OperatorWalletSpec = z.infer<typeof operatorWalletSpecSchema>;

// ---------------------------------------------------------------------------
// Gate + rule schemas (PR review)
// ---------------------------------------------------------------------------

/** Comparison operators for success criteria thresholds. */
export const comparisonOperators = ["gte", "gt", "lte", "lt", "eq"] as const;

/** A single threshold criterion (e.g., { metric: "coherent-change", gte: 0.8 }). */
export const thresholdCriterionSchema = z
  .object({
    metric: z.string().min(1),
  })
  .catchall(z.number().min(0).max(1))
  .refine(
    (obj) => {
      const ops = Object.keys(obj).filter((k) =>
        (comparisonOperators as readonly string[]).includes(k)
      );
      return ops.length === 1;
    },
    {
      message:
        "Exactly one comparison operator (gte, gt, lte, lt, eq) required per threshold",
    }
  );

export type ThresholdCriterion = z.infer<typeof thresholdCriterionSchema>;

/** Success criteria block from a rule YAML. */
export const successCriteriaSchema = z.object({
  /** If true, missing metrics result in neutral instead of fail. */
  neutral_on_missing_metrics: z.boolean().optional().default(false),
  /** All criteria must pass. */
  require: z.array(thresholdCriterionSchema).optional(),
  /** At least one criterion must pass. */
  any_of: z.array(thresholdCriterionSchema).optional(),
});

export type SuccessCriteria = z.infer<typeof successCriteriaSchema>;

/**
 * Evaluation entry: key-value where key is the metric name
 * and value is the evaluation prompt text.
 */
export const evaluationEntrySchema = z
  .record(z.string(), z.string())
  .refine((obj) => Object.keys(obj).length === 1, {
    message:
      "Each evaluation entry must have exactly one key (the metric name)",
  });

/** Rule YAML schema (e.g., .cogni/rules/pr-syntropy-coherence.yaml). */
export const ruleSchema = z.object({
  id: z.string().min(1),
  schema_version: z.string().optional(),
  blocking: z.boolean().optional().default(true),
  workflow_id: z.string().optional(),
  evaluations: z.array(evaluationEntrySchema).min(1),
  success_criteria: successCriteriaSchema,
});

export type Rule = z.infer<typeof ruleSchema>;

/** Gate config: review-limits (no LLM — pure numeric checks). */
export const reviewLimitsGateSchema = z.object({
  type: z.literal("review-limits"),
  id: z.string().optional(),
  with: z.object({
    max_changed_files: z.number().int().positive().optional(),
    max_total_diff_kb: z.number().positive().optional(),
  }),
});

/** Gate config: ai-rule (invokes LLM for rule evaluation). */
export const aiRuleGateSchema = z.object({
  type: z.literal("ai-rule"),
  id: z.string().optional(),
  with: z.object({
    rule_file: z.string().min(1),
  }),
});

/** Union of all gate types. */
export const gateConfigSchema = z.discriminatedUnion("type", [
  reviewLimitsGateSchema,
  aiRuleGateSchema,
]);

export type GateConfig = z.infer<typeof gateConfigSchema>;

/** Gates array schema. */
export const gatesArraySchema = z.array(gateConfigSchema);

// ---------------------------------------------------------------------------
// Scope identity primitives
// ---------------------------------------------------------------------------

/** Stable opaque scope identifier — always UUID */
export const scopeIdSchema = z.string().uuid();

/** Human-friendly scope slug — lowercase, kebab, max 32 chars */
export const scopeKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

// ---------------------------------------------------------------------------
// Node registry (operator-only — declares child nodes in the monorepo)
// ---------------------------------------------------------------------------

/**
 * Schema for a single node entry in the operator's nodes[] registry.
 * Each entry points to a node directory containing its own .cogni/repo-spec.yaml.
 * Per REPO_SPEC_AUTHORITY: operator repo-spec is the node discovery source.
 */
export const nodeRegistryEntrySchema = z.object({
  /** Node UUID — must match the node's own repo-spec node_id */
  node_id: z.string().uuid(),
  /** Human-friendly display name (for logging, UI, dashboards) */
  node_name: z.string().min(1),
  /** Path relative to repo root (e.g., "." for operator, "nodes/poly" for poly) */
  path: z.string().min(1),
  /** Docker-internal endpoint for billing callback routing (optional — runtime config) */
  endpoint: z.string().optional(),
});

export type NodeRegistryEntry = z.infer<typeof nodeRegistryEntrySchema>;

/**
 * Schema for full .cogni/repo-spec.yaml structure.
 * Validates structure only; chain alignment checked in accessors via chainId parameter.
 */
export const repoSpecSchema = z
  .object({
    /** Unique node identity — scopes all ledger tables. Generated once at init, never changes. */
    node_id: z.string().uuid("node_id must be a valid UUID"),

    /** Stable opaque scope UUID — DB FK, never changes. Optional for backward compat. */
    scope_id: scopeIdSchema.optional(),

    /** Human-friendly scope slug — for display, logs, schedule IDs. Optional for backward compat. */
    scope_key: scopeKeySchema.optional(),

    /** Activity ledger configuration (optional — needed only when LEDGER_INGEST is enabled) */
    activity_ledger: activityLedgerSpecSchema.optional(),

    /** Operator wallet configuration (optional — needed only when operator wallet is enabled) */
    operator_wallet: operatorWalletSpecSchema.optional(),

    /** DAO governance configuration */
    cogni_dao: z.object({
      /**
       * Chain ID as string or number (YAML flexibility).
       * Normalized to string at extraction time.
       */
      chain_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      /** DAO contract address (EVM 0x-prefixed, 40 hex chars) */
      dao_contract: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address")
        .optional(),
      /** Aragon voting plugin contract address */
      plugin_contract: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address")
        .optional(),
      /** CogniSignal contract address */
      signal_contract: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address")
        .optional(),
      /** Proposal launcher base URL (for deep links) */
      base_url: z.string().url().optional(),
    }),

    /** Payment activation status — pending_activation until node:activate-payments completes */
    payments: z
      .object({
        status: z.enum(["pending_activation", "active"]),
      })
      .optional(),

    /** Payment configuration (optional — populated by node:activate-payments) */
    payments_in: z
      .object({
        /** Inbound payment configuration for USDC credits top-up */
        credits_topup: creditsTopupSpecSchema,
      })
      .optional(),

    /** Governance schedule configuration (optional — defaults to empty schedules) */
    governance: governanceSpecSchema.optional().default({ schedules: [] }),

    /** PR review gate configuration (optional — gates run in declared order). */
    gates: gatesArraySchema.optional(),

    /** Whether gate errors/timeouts result in failure instead of neutral. */
    fail_on_error: z.boolean().optional().default(false),

    /** Node registry — operator-only. Declares child nodes in the monorepo. */
    nodes: z.array(nodeRegistryEntrySchema).optional(),
  })
  .passthrough();

export type RepoSpec = z.infer<typeof repoSpecSchema>;
