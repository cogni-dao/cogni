// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/review.internal.v1.contract`
 * Purpose: Wire contracts for the operator's internal PR-review GitHub plane.
 * Scope: Zod request/response shapes for POST /api/internal/review/* (worker→operator review delegation, bug.5000); does not implement the routes or business logic.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN required on every endpoint.
 *   - WORKER_HOLDS_NO_GITHUB_CRED: the App private key lives only in the operator.
 *   - Self-contained zod4 schemas — repo-spec is zod3 and must NOT be composed in
 *     (cross-package zod version hazard, see zod-version-cross-package.spec.ts).
 *     The gate/rule/owningNode shapes mirror @cogni/repo-spec structurally; the
 *     operator produces already-validated repo-spec objects, so interiors are
 *     permissive and only the envelope is strict.
 *   - All consumers use z.infer types.
 * Side-effects: none
 * Links: docs/spec/unified-graph-launch.md, docs/spec/scheduler.md, bug.5000,
 *   nodes/operator/app/src/app/api/internal/review/*, services/scheduler-worker/src/adapters/review-http.ts
 * @internal
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared review primitives
// ---------------------------------------------------------------------------

/** GitHub repo coordinates + the App installation that grants access. */
const RepoTargetSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** GitHub App installation id (public — carried from the webhook payload). */
  installationId: z.number().int().positive(),
});

/** GitHub check-run conclusion values the review plane emits. */
export const ReviewCheckRunConclusionSchema = z.enum([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
]);

// ---------------------------------------------------------------------------
// create-check-run
// ---------------------------------------------------------------------------

export const InternalReviewCreateCheckRunInputSchema = RepoTargetSchema.extend({
  headSha: z.string().min(1),
});

export const InternalReviewCreateCheckRunOutputSchema = z.object({
  checkRunId: z.number().int(),
});

// ---------------------------------------------------------------------------
// update-check-run
// ---------------------------------------------------------------------------

export const InternalReviewUpdateCheckRunInputSchema = RepoTargetSchema.extend({
  checkRunId: z.number().int(),
  conclusion: ReviewCheckRunConclusionSchema,
  title: z.string(),
  summary: z.string(),
});

export const InternalReviewUpdateCheckRunOutputSchema = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// post-pr-comment (with optional server-side staleness guard)
// ---------------------------------------------------------------------------

export const InternalReviewPostPrCommentInputSchema = RepoTargetSchema.extend({
  prNumber: z.number().int().positive(),
  body: z.string(),
  /**
   * When set, the operator re-reads the PR head SHA and skips the comment if it
   * no longer matches (the PR was pushed during review). Mirrors the old
   * worker-side staleness guard, now owned by the GitHub plane.
   */
  expectedHeadSha: z.string().optional(),
});

export const InternalReviewPostPrCommentOutputSchema = z.object({
  posted: z.boolean(),
  /** Set when posted=false. "stale" => head moved; comment intentionally skipped. */
  reason: z.literal("stale").optional(),
});

// ---------------------------------------------------------------------------
// pr-context (GitHub reads + repo-spec orchestration, all on the operator)
// ---------------------------------------------------------------------------

export const InternalReviewPrContextInputSchema = RepoTargetSchema.extend({
  prNumber: z.number().int().positive(),
});

const EvidenceBundleSchema = z.object({
  prNumber: z.number().int(),
  prTitle: z.string(),
  prBody: z.string(),
  headSha: z.string(),
  baseBranch: z.string(),
  changedFiles: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patches: z.array(z.object({ filename: z.string(), patch: z.string() })),
  totalDiffBytes: z.number().int(),
});

/** Mirror of @cogni/repo-spec OwningNode (discriminated on `kind`). */
const OwningNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    nodeId: z.string(),
    path: z.string(),
    rideAlongApplied: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("conflict"),
    nodes: z.array(z.object({ nodeId: z.string(), path: z.string() })),
    operatorPaths: z.array(z.string()),
    operatorNodeId: z.string().optional(),
  }),
  z.object({ kind: z.literal("miss") }),
]);

/**
 * Gate + rule interiors are permissive: the operator parsed them through
 * @cogni/repo-spec's own (zod3) schemas before returning, so re-validating the
 * full shape here would only risk version-skew false negatives. The worker
 * re-asserts the repo-spec types where it consumes them.
 */
const GatesConfigSchema = z.object({
  gates: z.array(z.looseObject({ type: z.string() })),
  failOnError: z.boolean(),
});

const RuleSchema = z.looseObject({
  id: z.string(),
  evaluations: z.array(z.record(z.string(), z.string())),
});

export const InternalReviewPrContextOutputSchema = z.object({
  evidence: EvidenceBundleSchema,
  /**
   * Node-controlled PR review on/off (repo-spec `review.enabled`). Defaults to
   * true so older operators that don't send it are treated as enabled.
   */
  reviewEnabled: z.boolean().optional().default(true),
  gatesConfig: GatesConfigSchema,
  rules: z.record(z.string(), RuleSchema),
  graphMessages: z.array(z.object({ role: z.string(), content: z.string() })),
  responseFormat: z.object({ prompt: z.string(), schemaId: z.string() }),
  modelRef: z.object({
    providerKey: z.string(),
    modelId: z.string(),
    connectionId: z.string().optional(),
  }),
  repoSpecYaml: z.string().optional(),
  changedFiles: z.array(z.string()),
  owningNode: OwningNodeSchema,
});

// ---------------------------------------------------------------------------
// Operation descriptors
// ---------------------------------------------------------------------------

export const internalReviewCreateCheckRunOperation = {
  id: "review.create-check-run.internal.v1",
  summary: "Create a PR-review GitHub Check Run (scheduler-worker → operator)",
  description:
    "Internal endpoint called by the scheduler-worker's review activities to open a GitHub Check Run using the operator's GitHub App auth. Worker holds no GitHub credential.",
  input: InternalReviewCreateCheckRunInputSchema,
  output: InternalReviewCreateCheckRunOutputSchema,
} as const;

export const internalReviewUpdateCheckRunOperation = {
  id: "review.update-check-run.internal.v1",
  summary:
    "Finalize a PR-review GitHub Check Run (scheduler-worker → operator)",
  description:
    "Internal endpoint to complete a Check Run with a conclusion + formatted output, using the operator's GitHub App auth.",
  input: InternalReviewUpdateCheckRunInputSchema,
  output: InternalReviewUpdateCheckRunOutputSchema,
} as const;

export const internalReviewPostPrCommentOperation = {
  id: "review.post-pr-comment.internal.v1",
  summary: "Post a PR-review comment (scheduler-worker → operator)",
  description:
    "Internal endpoint to post an issue comment on a PR, with an optional head-SHA staleness guard, using the operator's GitHub App auth.",
  input: InternalReviewPostPrCommentInputSchema,
  output: InternalReviewPostPrCommentOutputSchema,
} as const;

export const internalReviewPrContextOperation = {
  id: "review.pr-context.internal.v1",
  summary: "Fetch PR review context (scheduler-worker → operator)",
  description:
    "Internal endpoint that reads PR metadata + files + repo-spec + rule files via the operator's GitHub App auth, resolves the owning domain, and returns the full review context. Worker holds no GitHub credential.",
  input: InternalReviewPrContextInputSchema,
  output: InternalReviewPrContextOutputSchema,
} as const;

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type InternalReviewCreateCheckRunInput = z.infer<
  typeof InternalReviewCreateCheckRunInputSchema
>;
export type InternalReviewCreateCheckRunOutput = z.infer<
  typeof InternalReviewCreateCheckRunOutputSchema
>;
export type InternalReviewUpdateCheckRunInput = z.infer<
  typeof InternalReviewUpdateCheckRunInputSchema
>;
export type InternalReviewUpdateCheckRunOutput = z.infer<
  typeof InternalReviewUpdateCheckRunOutputSchema
>;
export type InternalReviewPostPrCommentInput = z.infer<
  typeof InternalReviewPostPrCommentInputSchema
>;
export type InternalReviewPostPrCommentOutput = z.infer<
  typeof InternalReviewPostPrCommentOutputSchema
>;
export type InternalReviewPrContextInput = z.infer<
  typeof InternalReviewPrContextInputSchema
>;
export type InternalReviewPrContextOutput = z.infer<
  typeof InternalReviewPrContextOutputSchema
>;
export type ReviewCheckRunConclusion = z.infer<
  typeof ReviewCheckRunConclusionSchema
>;
