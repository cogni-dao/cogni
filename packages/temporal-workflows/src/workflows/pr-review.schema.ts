// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/pr-review.schema`
 * Purpose: Zod schema for `PrReviewWorkflowInput` — the single source of truth for the PR-review workflow's input shape.
 * Scope: Schema definition + `z.infer<>` type export. Does not contain business logic, runtime I/O, or side-effects.
 * Invariants:
 *   - SINGLE_INPUT_CONTRACT: schema is the single source of truth (see Purpose).
 *   - DISPATCH_FAIL_FAST: producers parse with this schema before `workflowClient.start(...)`.
 * Side-effects: none
 * Links: task.0419, PR #1067 (modelRef-shape regression — the regression class this schema closes), story.5102.
 * @public
 */

import { z } from "zod";

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);

/**
 * Host-bound code subject of a review (story.5102 REVIEW_SUBJECT_IS_HOST_BOUND). The verb resolves
 * it from the reviewed node; the operator graph route re-validates owner/repo against
 * `resolveNodeRepo(nodeId)` before binding it to the run's code reader.
 */
export const ReviewCodeSubjectSchema = z
  .object({
    /** Reviewed node (UUID). v0: the operator only. */
    nodeId: z.string().uuid(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    baseSha: Sha40,
    headSha: Sha40,
  })
  .strict();
export type ReviewCodeSubject = z.infer<typeof ReviewCodeSubjectSchema>;

/**
 * Workflow input contract for `PrReviewWorkflow`.
 *
 * Source-of-truth Zod schema. Both the producer (`startPrReview` in
 * `nodes/operator/app/src/app/_facades/review/request.server.ts`, called only by
 * `POST /api/v1/vcs/review`) and the
 * consumer (`PrReviewWorkflow` + activities in `services/scheduler-worker`)
 * consume the inferred type via `z.infer<typeof PrReviewWorkflowInputSchema>`.
 *
 * Why a Zod schema and not a plain TS interface? Workflow input flows over
 * Temporal's wire (activity payloads serialize/deserialize as JSON). A TS
 * interface only enforces shape at compile time on each side independently —
 * if dispatch and activity drift in a field's name or type, the Temporal
 * runtime happily passes a malformed object through. PR #1067 fixed exactly
 * this regression for `model` → `modelRef`. A Zod schema validated at the
 * dispatch boundary catches the drift at the source.
 */
export const PrReviewWorkflowInputSchema = z
  .object({
    /**
     * Node that EXECUTES the review graph (the operator, from repo-spec). Routes execution.
     * The reviewed node lives only in `codeSubject.nodeId` (two nodes, kept apart).
     */
    nodeId: z.string().uuid(),
    /** GitHub repo owner (login). */
    owner: z.string().min(1),
    /** GitHub repo name. */
    repo: z.string().min(1),
    /** Pull request number. */
    prNumber: z.number().int().positive(),
    /** PR head SHA pinned by the verb — keys workflow identity and the code reads. */
    headSha: Sha40,
    /** PR base SHA pinned by the verb — repo-spec and rules are read here. */
    baseSha: Sha40,
    /** GitHub App installation ID for this repo. */
    installationId: z.number().int().positive(),
    /** Requesting developer (UUID). The run actor (always the developer, whoever pays). */
    actorUserId: z.string().uuid(),
    /** Payer billing account (UUID): the developer's own, or the system tenant when `payerKind` is `system_free`. */
    billingAccountId: z.string().uuid(),
    /** The developer billing account's default virtual key. */
    virtualKeyId: z.string().min(1),
    /** Unique id of this review request; the check run carries it as `external_id`. */
    requestId: z.string().uuid(),
    /** User id that requested the review (audit; equals actorUserId). */
    requestedBy: z.string().uuid(),
    /** Repository and commits the review graph may read. */
    codeSubject: ReviewCodeSubjectSchema,
    /**
     * Who pays (story.0038). `developer` (default): the requesting developer's own account pays, and
     * the reviewed repo-spec may pick the model. `system_free`: a linked node's review; the system tenant
     * pays a $0 receipt, `billingAccountId` is the system account, the actor stays the developer, and the
     * model is ALWAYS the operator default (the repo-spec's `review.model` is ignored). Histories started
     * before this field existed replay unchanged: it is read only on the dev-triggered path.
     */
    payerKind: z.enum(["developer", "system_free"]).default("developer"),
  })
  .strict();
// .strict() mode: typo'd field names (`virtualKeyld` with lowercase L,
// `pull_request_number` instead of `prNumber`) reject at parse time.
// Default Zod `.passthrough()`/strip behavior would silently ignore them,
// recreating the modelRef-shape regression class for renamed fields.

/**
 * Inferred TS type for `PrReviewWorkflow`'s input.
 *
 * Per SINGLE_INPUT_CONTRACT: never duplicate this shape as a separate
 * interface. Always `import { type PrReviewWorkflowInput } from ...` and
 * let the Zod schema be the source of truth.
 */
export type PrReviewWorkflowInput = z.infer<typeof PrReviewWorkflowInputSchema>;
