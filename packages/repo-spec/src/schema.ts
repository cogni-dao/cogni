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

  /**
   * Purchase-side price markup multiplier (governance config; was env USER_PRICE_MARKUP_FACTOR).
   * Drives the OpenRouter top-up amount and the 0xSplits allocation (DAO margin).
   * Default is tuned for a 95% provider top-up / 5% DAO Split margin with a 5% provider fee:
   * 1 / (0.95 top-up share × 0.95 fee complement). Distinct from spend-side LLM markup.
   */
  markup_factor: z.number().min(1.0).default(1.10803324099723),

  /**
   * Fraction of purchased credits minted as a system-tenant (DAO) bonus (0–1).
   * Default 0 = no system-account credit increase (the DAO earns USDC margin via the
   * Split, not free minted AI credits). New nodes inherit 0; a node opts back in explicitly.
   */
  revenue_share: z.number().min(0).max(1).default(0),
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
 * Schema for the unified `governance` section of repo-spec — the node/scope's
 * on-chain DAO identity (contracts + chain) AND its governance schedules.
 * (identity-model.md `scope_id (1)──(1) dao_address`: each scope has one DAO; this
 * is its governance binding.) All fields optional — a node without on-chain
 * governance still validates; the DAO accessors return null when identity is incomplete.
 */
export const governanceSpecSchema = z.object({
  /** Chain ID as string or number (YAML flexibility); normalized to string. */
  chain_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .optional(),
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
  /** Governance council schedules (cron-triggered charters) */
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

// ---------------------------------------------------------------------------
// Node-facing recurring-work schedules (story.5008 / task.5030)
// ---------------------------------------------------------------------------

/**
 * Schema for a single node-facing schedule entry.
 *
 * This is the left edge a node owns (CATALOG_IS_SSOT / node-baas "node declares
 * shape, operator wires env"): a node declares a recurring job in its own
 * repo-spec; the operator runs it on schedule under that node's tenant identity.
 *
 * Invariants (review G3 — node↔Temporal tenant interface):
 *   - WORKFLOWTYPE_FROM_ROUTE_XOR_GRAPH: exactly one of `route` (http-dispatch →
 *     NodeTaskWorkflow) or `graph` (graph run → GraphRunWorkflow) is set. There is
 *     NO node-facing `target` enum — that is operator vocabulary; the workflowType
 *     is *inferred* from which field is present (route XOR graph).
 *   - PLATFORM_OVERLAP_AND_CATCHUP: `overlap`/`catchupWindow` are NOT node-facing.
 *     They are platform invariants the operator fixes (OVERLAP_SKIP_DEFAULT /
 *     CATCHUP_WINDOW_ZERO). The schema does not accept them — a node cannot tune them.
 *   - ROUTE_IS_RELATIVE: `route` is a relative path on the node's own resolved host
 *     (operator allow-lists it to the node's nodeUrl — never an absolute/foreign URL).
 *   - PAYLOAD_OPAQUE: `payload` is opaque to the operator; the node's route owns its
 *     meaning. The operator forwards it verbatim inside the NodeTaskInput envelope.
 *   - `id` is stable → it derives both the scheduleId and the Temporal workflowId
 *     (`node-task:{node}:{id}` — WORKFLOW_ID_STABILITY).
 */
export const nodeScheduleSchema = z
  .object({
    /** Stable schedule id — derives scheduleId + workflowId. Lowercase kebab token. */
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{0,63}$/,
        "id must be a lowercase kebab token (max 64 chars)"
      ),
    /** 5-field cron expression (minute hour day month weekday) */
    cron: z
      .string()
      .regex(
        /^(\S+\s+){4}\S+$/,
        "Cron must be a 5-field expression (minute hour day month weekday)"
      ),
    /** IANA timezone (defaults to UTC) */
    timezone: z.string().default("UTC"),
    /**
     * Relative HTTP route on the node's OWN host (http-dispatch). The operator
     * dispatches POST {nodeUrl}{route} under the node's tenant principal. Mutually
     * exclusive with `graph`. Must be a leading-slash relative path (no host, no scheme).
     */
    route: z
      .string()
      .regex(
        /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/,
        "route must be a relative path beginning with '/' on the node's own host (no scheme/host)"
      )
      .optional(),
    /** Graph id to execute (graph run → GraphRunWorkflow). Mutually exclusive with `route`. */
    graph: z.string().min(1).optional(),
    /**
     * Opaque job payload forwarded verbatim to the node's route / graph input.
     * The operator never interprets it; the node's handler owns its meaning.
     */
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasRoute = entry.route !== undefined;
    const hasGraph = entry.graph !== undefined;
    // WORKFLOWTYPE_FROM_ROUTE_XOR_GRAPH — exactly one
    if (hasRoute === hasGraph) {
      ctx.addIssue({
        code: "custom",
        message:
          "Exactly one of `route` (http-dispatch) or `graph` (graph run) must be set per schedule",
      });
    }
    // ROUTE_IS_RELATIVE — reject anything that smells like an absolute/foreign URL
    if (
      hasRoute &&
      entry.route &&
      /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.route)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["route"],
        message:
          "route must not be an absolute URL — relative path on the node's own host only",
      });
    }
  });

export type NodeScheduleSpec = z.infer<typeof nodeScheduleSchema>;

/**
 * Node-facing `schedules` block.
 * Optional — existing deployments without recurring work continue to work.
 * Duplicate ids are rejected (each id maps to one stable schedule/workflow).
 */
export const nodeSchedulesSchema = z
  .array(nodeScheduleSchema)
  .default([])
  .refine((arr) => new Set(arr.map((s) => s.id)).size === arr.length, {
    message: "Duplicate schedule ids in schedules[]",
  });

export type NodeSchedules = z.infer<typeof nodeSchedulesSchema>;

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

/**
 * Schema for payments_out.steward_wallet configuration.
 *
 * The steward wallet is a HUMAN-CUSTODIED wallet (EOA / hardware wallet) that
 * settles vendor invoices the operator wallet cannot pay programmatically —
 * vendors whose crypto checkout is a per-session / per-invoice hosted flow
 * (OpenRouter Coinbase Business Checkout; Cherry → Coingate). The operator
 * Privy wallet funds this one pinned address via a single constrained transfer
 * (OperatorWalletPort.withdrawToSteward); a human then completes each vendor
 * checkout in USDC. Deliberately node-generic and NOT named "operator" to avoid
 * overloading the operator node / operator wallet. See docs/design/node-steward-wallet.md.
 */
export const stewardWalletSpecSchema = z.object({
  /** Checksummed EVM address of the human-custodied steward wallet (USDC on Base). */
  address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Steward wallet address must be a valid EVM address (0x + 40 hex chars)"
    ),
});

export type StewardWalletSpec = z.infer<typeof stewardWalletSpecSchema>;

function isDoltHubRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "doltremoteapi.dolthub.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[^/]+\/[^/]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Schema for the node-local knowledge plane declaration.
 * Credentials are never stored here; the repo-spec only pins the Cogni-owned
 * DoltHub repository identity that this node mirrors to.
 */
export const knowledgeRemoteSpecSchema = z
  .object({
    provider: z.literal("dolthub"),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z.string().regex(/^knowledge-[a-z][a-z0-9-]{0,63}$/),
    url: z.string().refine(isDoltHubRemoteUrl, {
      message:
        "DoltHub remote URL must be https://doltremoteapi.dolthub.com/<owner>/<repo> with no credentials",
    }),
    custody: z.literal("cogni-owned"),
  })
  .superRefine((remote, ctx) => {
    let url: URL;
    try {
      url = new URL(remote.url);
    } catch {
      return;
    }
    const expected = `/${remote.owner}/${remote.repo}`;
    if (url.pathname !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "DoltHub remote URL path must match knowledge.remote owner/repo",
      });
    }
  });

export const knowledgeSpecSchema = z.object({
  database: z.string().regex(/^knowledge_[a-z][a-z0-9_]{0,63}$/),
  remote: knowledgeRemoteSpecSchema,
});

export type KnowledgeRemoteSpec = z.infer<typeof knowledgeRemoteSpecSchema>;
export type KnowledgeSpec = z.infer<typeof knowledgeSpecSchema>;

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

/**
 * PR review configuration — the node-author-facing on/off + model toggle.
 *
 * The operator reviews a PR by reading the TARGET repo's own repo-spec, so this
 * block makes git PR review 100% node-controlled (no operator-side hardcode):
 *   - `enabled` — when `false`, the operator skips review entirely (no Check Run,
 *     no comment). Defaults to `true` for backward-compat (review was always-on).
 *   - `model` — platform model id (LiteLLM-resolvable, e.g. `gpt-4o-mini`) the
 *     `pr-review` graph runs with. Omitted → operator default.
 */
export const reviewConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  model: z.string().min(1).optional(),
});

export type ReviewConfig = z.infer<typeof reviewConfigSchema>;

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
  /** Path relative to repo root (e.g., "nodes/operator" for operator, "nodes/<slug>" for a child) */
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

    /**
     * Human-facing node identity (display, not a key) — the SSOT a node self-describes from. `name` is
     * the node slug (e.g. `operator`, `beacon`). The display layers, all projected to the node's public
     * `/.well-known/agent.json` so the operator reads them rather than hardcoding (IDENTITY_IS_REPO_SPEC_PROJECTION):
     *   - `hook`    — punchy ~5-word tagline shown on gallery cards / node-page headings.
     *   - `mission` — the 1–3 sentence north-star the cognition substrate surfaces at session start.
     *   - `brand`   — visual identity: `thumbnail` is a URL the NODE hosts (e.g. its OG image) so brand
     *     stays sovereign + current with no operator asset-hosting; `color` tints the monogram fallback.
     * All optional for back-compat (a node with only `name` falls back to title-cased slug + monogram).
     */
    intent: z
      .object({
        name: z.string().min(1),
        hook: z.string().min(1).max(80).optional(),
        mission: z.string().min(1).optional(),
        brand: z
          .object({
            // SSOT for the node's visual mark: a Lucide icon NAME (PascalCase, e.g. `Gamepad2`).
            // ONE field, every surface reads it — app header, gallery card, og:image, favicon — so
            // the icon is never hand-coded per-fork in AppHeader JSX again (that was the split-brain).
            icon: z.string().optional(),
            // `color` tints the brand mark (icon + monogram fallback).
            color: z.string().optional(),
            // Deprecated: a node-hosted image URL/path. Superseded by `icon` (which the node's
            // /opengraph-image route renders to a PNG). Kept optional for back-compat during migration.
            thumbnail: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),

    /** Stable opaque scope UUID — DB FK, never changes. Optional for backward compat. */
    scope_id: scopeIdSchema.optional(),

    /** Human-friendly scope slug — for display, logs, schedule IDs. Optional for backward compat. */
    scope_key: scopeKeySchema.optional(),

    /** Activity ledger configuration (optional — needed only when LEDGER_INGEST is enabled) */
    activity_ledger: activityLedgerSpecSchema.optional(),

    /** Operator wallet configuration (optional — needed only when operator wallet is enabled) */
    operator_wallet: operatorWalletSpecSchema.optional(),

    /** Node-local knowledge plane declaration (optional for pre-knowledge nodes) */
    knowledge: knowledgeSpecSchema.optional(),

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

    /**
     * Outbound payment configuration (optional). Declares the human-custodied
     * steward wallet that settles vendor invoices via manual crypto checkout.
     * Besides the 0xSplits distribute, this is the operator wallet's only
     * outbound destination (a single pinned address, funded by withdrawToSteward).
     */
    payments_out: z
      .object({
        /** Human-custodied wallet that settles vendor invoices (OpenRouter, Cherry). */
        steward_wallet: stewardWalletSpecSchema,
      })
      .optional(),

    /** Governance schedule configuration (optional — defaults to empty schedules) */
    /**
     * Unified governance section — DAO identity (contracts + chain) + council
     * schedules. Required (every node declares its governance binding); inner
     * fields optional so DAO identity can be incomplete pre-activation, and
     * `schedules` defaults to [].
     */
    governance: governanceSpecSchema,

    /**
     * Node-facing recurring-work schedules (story.5008). The node declares
     * recurring jobs; the operator reconciles them into Temporal Schedules under
     * the node's tenant identity (see syncNodeSchedules). Optional — defaults to
     * empty. Distinct from `governance.schedules` (operator charters): this is the
     * node-author-facing contract (route XOR graph; no operator vocab leak).
     */
    schedules: nodeSchedulesSchema.optional().default([]),

    /** PR review on/off + model selection (optional — defaults to enabled). */
    review: reviewConfigSchema.optional(),

    /** PR review gate configuration (optional — gates run in declared order). */
    gates: gatesArraySchema.optional(),

    /** Whether gate errors/timeouts result in failure instead of neutral. */
    fail_on_error: z.boolean().optional().default(false),

    /** Node registry — operator-only. Declares child nodes in the monorepo. */
    nodes: z.array(nodeRegistryEntrySchema).optional(),
  })
  .passthrough();

export type RepoSpec = z.infer<typeof repoSpecSchema>;
