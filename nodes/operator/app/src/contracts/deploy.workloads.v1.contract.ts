// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/deploy.workloads.v1`
 * Purpose: Wire contract for `POST/GET /api/v1/deploy/workloads` — record intent to deploy one declared
 *   workload at a source sha, and read what the node-deploy sequencer has done about it (task.5400).
 * Scope: Request/response schemas only. The route only RECORDS intent; the sequencer executes it.
 * Invariants:
 *   - INTENT_ONLY: a 200 means "a release and its desired row were written", never "deployed".
 *   - FULL_SHA: `sourceSha` is a full 40-hex git sha; a branch name or short sha is a 400.
 *   - STRICT_INPUT: unknown keys are a 400.
 *   - READ_MODEL_IS_ADDITIVE: the timeline/state fields only ADD to the pre-existing GET shape.
 *     `GET /deploy/workloads/releases/{releaseId}` shares GET's authz gate and addressing.
 * Side-effects: none (schemas only)
 * Links: src/app/api/v1/deploy/workloads/route.ts, features/node-deploy/sequencer.ts,
 *   features/node-deploy/release-view.ts
 * @public
 */

import { z } from "zod";

export const DeployWorkloadEnvSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

export const DeployWorkloadInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
  workload: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/, "workload must be a DNS-safe name"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex sha"),
});

/** Game-day kill intent: the same addressing as a release, with no sha. */
export const DeployWorkloadGameDayInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
  workload: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/, "workload must be a DNS-safe name"),
});

export const DeployWorkloadQuerySchema = z.strictObject({
  nodeId: z.string().min(1),
  env: DeployWorkloadEnvSchema,
  workload: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .optional(),
});

export const DeployWorkloadRecordedSchema = z.object({
  releaseId: z.string().uuid(),
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  workload: z.string(),
  sourceSha: z.string(),
  desiredState: z.literal("running"),
});

export type DeployWorkloadGameDayInput = z.infer<
  typeof DeployWorkloadGameDayInputSchema
>;
export type DeployWorkloadInput = z.infer<typeof DeployWorkloadInputSchema>;
export type DeployWorkloadQuery = z.infer<typeof DeployWorkloadQuerySchema>;
export type DeployWorkloadRecorded = z.infer<
  typeof DeployWorkloadRecordedSchema
>;

// ---------------------------------------------------------------------------------------------
// Read model (task.5400 observability): release state, timestamps and per-attempt step timelines.
// A node developer follows deploy progress, success and failure from these — never by polling
// `/version`. Derivation rules live in `features/node-deploy/release-view.ts`.
// ---------------------------------------------------------------------------------------------

/**
 * `queued`      recorded, no attempt yet.
 * `deploying`   an attempt is mid-flight, or a failed lease is still being closed.
 * `active`      an attempt of this release serves.
 * `parked`      `maxFailedAttempts` (3) consecutive failed attempts: no paid create until a NEW release.
 * `superseded`  the workload's desired release is a newer one (`activatedAt` says if this one served).
 * `failed`      newest attempt failed or its live lease was lost, fewer than 3 failures: the next
 *               attempt will be planned by the sequencer.
 */
export const DEPLOY_RELEASE_STATES = [
  "queued",
  "deploying",
  "active",
  "parked",
  "superseded",
  "failed",
] as const;
export const DeployReleaseStateSchema = z.enum(DEPLOY_RELEASE_STATES);

/** One persisted sequencer step; the same fields the `node_deploy_step` Loki event carries. */
export const DeployAttemptStepSchema = z.object({
  step: z.string(),
  outcome: z.string(),
  reason: z.string().optional(),
  dseq: z.string().optional(),
  provider: z.string().optional(),
  /** Milliseconds from the attempt row's creation to this step. */
  elapsedMs: z.number().int().nonnegative().optional(),
  at: z.string(),
});

export const DeployAttemptViewSchema = z.object({
  id: z.string(),
  releaseId: z.string(),
  attempt: z.number().int(),
  cogniKey: z.string(),
  externalName: z.string().nullable(),
  provider: z.string().nullable(),
  endpoints: z.array(z.string()),
  phase: z.string(),
  error: z.string().nullable(),
  unhealthySince: z.string().nullable(),
  createdAt: z.string().nullable(),
  leasedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Oldest first, newest 100 kept; empty for attempts that predate the timeline. */
  steps: z.array(DeployAttemptStepSchema),
});

/** Admission is independent of outstanding paid-effect recovery and serving state. */
const AdmissionRefusalSchema = z.object({
  reason: z.string(),
  at: z.string().datetime(),
});

/** Release state + lead-time timestamps (ISO-8601). `leadTimeMs = activatedAt - recordedAt`. */
export const DeployReleaseTimelineSchema = z.object({
  releaseId: z.string(),
  sourceSha: z.string(),
  /** True when the workload's desired row points at this release. */
  current: z.boolean(),
  /** True when an attempt of this release backs the workload's live lease (even if superseded). */
  serving: z.boolean(),
  releaseState: DeployReleaseStateSchema,
  parkedReason: z.string().nullable(),
  /** Terminal verdict, including while an older paid effect is still being recovered. */
  admissionRefusal: AdmissionRefusalSchema.nullable().optional(),
  /** Terminal admission refusal time; absent on older responses. */
  admissionRefusedAt: z.string().datetime().nullable().optional(),
  recordedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  leadTimeMs: z.number().int().nonnegative().nullable(),
});

/** One workload of `GET /api/v1/deploy/workloads` (additive over the pre-timeline shape). */
export const DeployWorkloadViewSchema = z.object({
  workload: z.string(),
  desired: z.object({
    state: z.enum(["running", "stopped"]),
    releaseId: z.string(),
    sourceSha: z.string().optional(),
    releaseState: DeployReleaseStateSchema,
    parkedReason: z.string().nullable(),
    admissionRefusal: AdmissionRefusalSchema.nullable().optional(),
    /** Terminal admission refusal time; absent on older responses. */
    admissionRefusedAt: z.string().datetime().nullable().optional(),
    recordedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    activatedAt: z.string().nullable(),
    leadTimeMs: z.number().int().nonnegative().nullable(),
    serving: z.boolean(),
  }),
  /** The release whose attempt backs the live lease; differs from `desired.releaseId` mid-rollout. */
  servingReleaseId: z.string().nullable(),
  active: DeployAttemptViewSchema.nullable(),
  recentAttempts: z.array(DeployAttemptViewSchema),
});

export const DeployWorkloadsReadSchema = z.object({
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  workloads: z.array(DeployWorkloadViewSchema),
});

/** `GET /api/v1/deploy/workloads/releases/{releaseId}?nodeId=&env=` — same addressing as the list. */
export const DeployReleaseQuerySchema = z.strictObject({
  nodeId: z.string().min(1),
  env: DeployWorkloadEnvSchema,
});

export const DeployReleaseIdSchema = z.string().uuid();

export const DeployReleaseDetailSchema = z.object({
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  workload: z.string(),
  /** The workload's desired state, or null when no desired row exists. */
  desiredState: z.enum(["running", "stopped"]).nullable(),
  release: DeployReleaseTimelineSchema,
  /** Every attempt of this release the store still returns, oldest first. */
  attempts: z.array(DeployAttemptViewSchema),
});

export type DeployReleaseState = z.infer<typeof DeployReleaseStateSchema>;
export type DeployAttemptStep = z.infer<typeof DeployAttemptStepSchema>;
export type DeployAttemptView = z.infer<typeof DeployAttemptViewSchema>;
export type DeployReleaseTimeline = z.infer<typeof DeployReleaseTimelineSchema>;
export type DeployWorkloadView = z.infer<typeof DeployWorkloadViewSchema>;
export type DeployWorkloadsRead = z.infer<typeof DeployWorkloadsReadSchema>;
export type DeployReleaseDetail = z.infer<typeof DeployReleaseDetailSchema>;
