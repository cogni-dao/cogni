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
 *   - LANE_VIEW_IS_READ_ONLY (task.5479): `GET /deploy/workloads/lanes` is a sibling read over the same
 *     durable rows (serving, in-flight, trailing-24h superseded/parked history, per-lane KPIs). It
 *     shares GET's authz gate and addressing, writes nothing and admits or refuses nothing.
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

/**
 * A workload name: a DNS label that never contains `-mesh-` (task.5431). The sequencer's attempt-key
 * Secrets `nd-<id8>-<workload>-mesh-<release>-a<n>` are the only Secrets it may delete; refusing `-mesh-`
 * keeps every state password `nd-<id8>-<workload>` outside that allow-list. Same rule as repo-spec
 * `WORKLOAD_NAME_RE`; `tests/contract/deploy-workload-name.contract.test.ts` keeps the two in step.
 */
export const DEPLOY_WORKLOAD_NAME_RE = /^(?!.*-mesh-)[a-z][a-z0-9-]{0,62}$/;
export const DeployWorkloadNameSchema = z
  .string()
  .regex(
    DEPLOY_WORKLOAD_NAME_RE,
    "workload must be a DNS-safe name that does not contain -mesh-"
  );

export const DeployWorkloadInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
  workload: DeployWorkloadNameSchema,
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex sha"),
});

/** Game-day kill intent: the same addressing as a release, with no sha. */
export const DeployWorkloadGameDayInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
  workload: DeployWorkloadNameSchema,
});

export const DeployWorkloadQuerySchema = z.strictObject({
  nodeId: z.string().min(1),
  env: DeployWorkloadEnvSchema,
  workload: DeployWorkloadNameSchema.optional(),
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
  /** First entry into phase `active`, write-once (task.5442); absent if never or before the column. */
  activatedAt: z.string().optional(),
  /** Oldest first, newest 100 kept; empty for attempts that predate the timeline. */
  steps: z.array(DeployAttemptStepSchema),
  /** How the attempt reaches the shared substrate (task.5431, HR 18); absent on older attempts. */
  transport: z.enum(["egress", "mesh"]).optional(),
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

// ---------------------------------------------------------------------------------------------
// Lane view (task.5479, story.5159): queue awareness + per-lane KPIs. A LANE is one
// `{node, env, workload}`; its releases queue on ONE desired row, so a newer release supersedes an
// older one that has not finished. Derivation rules live in `features/node-deploy/lane-view.ts`.
// ---------------------------------------------------------------------------------------------

/** `GET /api/v1/deploy/workloads/lanes?nodeId=&env=[&workload=]` — same addressing as the list. */
export const DeployLanesQuerySchema = DeployWorkloadQuerySchema;

/**
 * The release a lane serves right now: an attempt of it is in phase `active` (the sequencer's ledger
 * claim, as in `GET /deploy/workloads`; not a `/version` probe).
 */
export const DeployLaneServingSchema = z.object({
  releaseId: z.string(),
  sourceSha: z.string().nullable(),
  sha8: z.string().nullable(),
  /** Principal that recorded the serving release (`user:<id>`), when the release row is readable. */
  requestedBy: z.string().nullable(),
  /** First activation of the serving attempt; falls back to its last phase change. */
  servingSince: z.string().nullable(),
});

/**
 * The release the lane is working on now: the desired release while it is not yet serving or parked.
 * A lane has ONE desired row, so queue depth is this field (0 or 1) plus `kpis.*.superseded`: releases
 * that were replaced before they finished are the ones that waited.
 */
export const DeployLaneInFlightSchema = z.object({
  releaseId: z.string(),
  sourceSha: z.string(),
  sha8: z.string(),
  state: z.enum(["queued", "deploying", "failed"]),
  /** Attempts the sequencer has made for this release. */
  attempts: z.number().int().nonnegative(),
  recordedAt: z.string().nullable(),
  /** First attempt's creation; null while `queued`. */
  startedAt: z.string().nullable(),
  /** Principal that recorded the release (`user:<id>`): who is deploying. */
  requestedBy: z.string(),
  /** Milliseconds since the release was recorded. */
  waitingMs: z.number().int().nonnegative().nullable(),
});

/** A release that ended without serving: replaced by a newer release, or parked by the sequencer. */
export const DeployLaneHistoryEntrySchema = z.object({
  releaseId: z.string(),
  sourceSha: z.string(),
  sha8: z.string(),
  outcome: z.enum(["superseded", "parked"]),
  requestedBy: z.string(),
  recordedAt: z.string(),
  /** Superseded: when the replacing release was recorded. Parked: the durable park instant. */
  endedAt: z.string(),
  reason: z.string(),
  /** An attempt of this release had already failed before it ended. */
  hadFailedAttempt: z.boolean(),
  /** Superseded only: the release that replaced it, and who recorded it. */
  supersededBy: z
    .object({
      releaseId: z.string(),
      sha8: z.string(),
      requestedBy: z.string(),
    })
    .nullable(),
});

/** One trailing window of the lane's KPIs. Ratios are null when nothing finished (never 0 or 1). */
export const DeployLaneWindowKpisSchema = z.object({
  windowHours: z.number().int().positive(),
  /** Releases that first activated in the window. */
  activated: z.number().int().nonnegative(),
  /** Releases the sequencer parked in the window. */
  parked: z.number().int().nonnegative(),
  /** `activated / (activated + parked)`. */
  successRatio: z.number().min(0).max(1).nullable(),
  /** Lead time (POST to first activation) of the activated releases, nearest-rank. */
  leadTimeP50Ms: z.number().int().nonnegative().nullable(),
  leadTimeP90Ms: z.number().int().nonnegative().nullable(),
  /** Releases replaced by a newer one before they finished, ended in the window. */
  superseded: z.number().int().nonnegative(),
});

export const DeployLaneViewSchema = z.object({
  workload: z.string(),
  desiredState: z.enum(["running", "stopped"]),
  /** The desired release and its state (a parked desired release is not in flight). */
  desired: z.object({
    releaseId: z.string(),
    sourceSha: z.string().nullable(),
    releaseState: DeployReleaseStateSchema,
    parkedReason: z.string().nullable(),
  }),
  serving: DeployLaneServingSchema.nullable(),
  inFlight: DeployLaneInFlightSchema.nullable(),
  /** Newest first; superseded and parked releases that ended in the trailing 24 hours. */
  history24h: z.array(DeployLaneHistoryEntrySchema),
  kpis: z.object({
    last24h: DeployLaneWindowKpisSchema,
    last7d: DeployLaneWindowKpisSchema,
  }),
});

export const DeployLanesReadSchema = z.object({
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  asOf: z.string(),
  /** The release read hit its row bound: the NEWEST releases may be missing, so windows may undercount. */
  truncated: z.boolean(),
  lanes: z.array(DeployLaneViewSchema),
});

export type DeployLaneServing = z.infer<typeof DeployLaneServingSchema>;
export type DeployLaneInFlight = z.infer<typeof DeployLaneInFlightSchema>;
export type DeployLaneHistoryEntry = z.infer<
  typeof DeployLaneHistoryEntrySchema
>;
export type DeployLaneWindowKpis = z.infer<typeof DeployLaneWindowKpisSchema>;
export type DeployLaneView = z.infer<typeof DeployLaneViewSchema>;
export type DeployLanesRead = z.infer<typeof DeployLanesReadSchema>;
