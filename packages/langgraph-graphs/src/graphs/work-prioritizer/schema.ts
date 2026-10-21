// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/schema`
 * Purpose: Judgment, plan, and decision schemas for the work prioritizer (dao-goals-design, story.5096).
 * Scope: Zod schemas and inferred types only. Does not call tools, LLMs, or read env.
 * Invariants:
 *   - ENUMS_NOT_FLOATS: the model returns only enums (impact 0–3, service class, effort) plus evidence ids;
 *     ranking is code (rank.ts), never a model-produced score.
 *   - NO_AGGREGATE_SCORE / NO_WEIGHTS: impact is per active goal; nothing sums or weights them.
 *   - DECISION_CARRIES_FULL_TABLE: a filed decision holds every actionable item's row, so a revert is a replay.
 * Side-effects: none
 * Links: dao-goals-design, rank.ts, plan.ts
 * @public
 */

import { z } from "zod";

/** Schema version stamped into every decision payload. */
export const DECISION_SCHEMA_VERSION = "work-prioritizer.decision/v2" as const;

/** Name of the deterministic ranking procedure (rank.ts). */
export const RANK_HEURISTIC = "lexicographic heuristic v2" as const;

export const SERVICE_CLASSES = [
  "expedite",
  "fixed_date",
  "standard",
  "intangible",
] as const;
export type ServiceClass = (typeof SERVICE_CLASSES)[number];

export const EFFORTS = ["S", "M", "L"] as const;
export type Effort = (typeof EFFORTS)[number];

/** A one-sentence claim backed by one evidence id (work item or hub entry fetched this cycle). */
export const EvidencedClaimSchema = z.object({
  text: z.string().min(1).max(400),
  evidenceId: z.string().min(1),
});
export type EvidencedClaim = z.infer<typeof EvidencedClaimSchema>;

export const HarmIfWaitSchema = EvidencedClaimSchema.extend({
  /** Days until the harm materially grows; null = no time-bound harm. p0 requires ≤ 7. */
  withinDays: z.number().int().min(0).nullable().default(null),
});

/** One item's judgment — the model's ONLY per-item output. */
export const ItemJudgmentSchema = z
  .object({
    itemId: z.string().min(1),
    /** Impact 0–3 keyed by active goal id (`goal-*`). Missing goal = 0. */
    impact: z.record(z.string(), z.number().int().min(0).max(3)).default({}),
    serviceClass: z.enum(SERVICE_CLASSES),
    /** Required iff serviceClass = fixed_date (ISO date). */
    fixedDate: z.string().nullable().default(null),
    effort: z.enum(EFFORTS),
    whyNow: EvidencedClaimSchema,
    harmIfWait: HarmIfWaitSchema,
    /** Model-flagged supersession; code verifies the id exists in the snapshot. */
    supersededBy: z.string().nullable().default(null),
  })
  .superRefine((j, ctx) => {
    if (j.serviceClass === "fixed_date" && !j.fixedDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedDate"],
        message: "fixed_date requires fixedDate",
      });
    }
  });
export type ItemJudgment = z.infer<typeof ItemJudgmentSchema>;

/** One row of the ranked table (every actionable item gets exactly one). */
export const RankedRowSchema = z.object({
  itemId: z.string(),
  revision: z.number().int().nullable(),
  from: z.number().int().nullable(),
  /** Current rank before this cycle (null = unset). */
  fromRank: z.number().int().nullable().default(null),
  to: z.number().int().min(0).max(4),
  rank: z.number().int().min(1),
  pinned: z.boolean(),
  serviceClass: z.enum(SERVICE_CLASSES).nullable(),
  maxImpact: z.number().int().min(0).max(3),
  /** P0P1_CITES_GOAL: the active goal (`goal-*`) this row serves; required for p0/p1. */
  goal: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  whyNow: EvidencedClaimSchema.nullable(),
  harmIfWait: HarmIfWaitSchema.nullable(),
  /** Gate codes that shaped this row (e.g. blocked_not_p0p1, duplicate_p4). */
  reasons: z.array(z.string()),
});
export type RankedRow = z.infer<typeof RankedRowSchema>;

/**
 * A changed row — the write seam for a later apply (id, priority, rank, and the revision it was planned
 * against for a compare-and-set patch). PROPOSE_ONLY: this graph never writes it.
 */
export const PlanRowSchema = z.object({
  itemId: z.string(),
  from: z.number().int().nullable(),
  to: z.number().int().min(0).max(4),
  rank: z.number().int().min(1),
  expectedRevision: z.number().int().nullable(),
});
export type PlanRow = z.infer<typeof PlanRowSchema>;

/** One memoized judgment (item revision it was made against + the judgment). */
export const MemoJudgmentSchema = z.object({
  itemId: z.string(),
  revision: z.number().int().nullable(),
  judgment: ItemJudgmentSchema,
});
export type MemoJudgment = z.infer<typeof MemoJudgmentSchema>;

/** Ids read before judging — stamped by code. */
export const ContextConsumedSchema = z.object({
  workItemIds: z.array(z.string()),
  knowledgeIds: z.array(z.string()),
  edoIds: z.array(z.string()),
});
export type ContextConsumed = z.infer<typeof ContextConsumedSchema>;

/** The JSON embedded in every filed EDO decision (design v4 §2.5). */
export const DecisionPayloadSchema = z.object({
  schemaVersion: z.literal(DECISION_SCHEMA_VERSION),
  status: z.literal("planned"),
  mode: z.literal("propose"),
  /**
   * DAILY_FULL_REVIEW / DELTA_SCOPE: `full` re-judged every actionable item; `delta` re-considered only
   * `delta` (current p0/p1, unprioritized, revision changed) and carried every other judgment.
   */
  scope: z.enum(["full", "delta"]),
  /** When the backlog was last fully reviewed (this cycle's time on a full review). */
  reviewedAt: z.string(),
  /** The ids this cycle re-considered (every snapshot item on a full review). */
  delta: z.array(z.string()),
  heuristic: z.literal(RANK_HEURISTIC),
  policyVersion: z.string(),
  promptVersion: z.string(),
  modelRef: z.string().nullable(),
  /** Idempotency key. */
  cycleId: z.string(),
  snapshotId: z.string(),
  priorDecisionId: z.string().nullable(),
  /** The active goal ids (`goal-*`) this cycle ranked against (listActiveGoals). */
  goals: z.array(z.string()),
  plan: z.array(PlanRowSchema),
  table: z.array(RankedRowSchema),
  diffVsPrior: z.array(
    z.object({
      itemId: z.string(),
      priorTo: z.number().nullable(),
      to: z.number(),
    })
  ),
  contextConsumed: ContextConsumedSchema,
  /**
   * MEMOIZED_JUDGMENTS: every item's judgment keyed by itemId@revision. The next cycle reuses a
   * judgment whose item revision, goals, and prompt version are unchanged.
   */
  judgments: z.array(MemoJudgmentSchema).default([]),
  /**
   * UNJUDGED_IS_EXPLICIT: items the model never judged, even after per-item repair. They rank p3,
   * are never p0/p1 or planned, and are listed here so the decision is never presented as complete.
   */
  unjudged: z.array(z.string()).default([]),
});
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;
