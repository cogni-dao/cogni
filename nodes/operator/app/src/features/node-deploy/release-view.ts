// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/release-view`
 * Purpose: Project the sequencer's durable rows (desired, release, attempts + their step timeline) into
 *   the node-developer read model: an explicit per-release state (`queued|deploying|active|parked|
 *   superseded|failed`), the park reason, the lead-time timestamps and the attempt timelines. A node
 *   developer reads deploy progress, success and failure from this view — never by polling `/version`.
 *   task.5400 / story.5127 (CEO: "a PARKED release is invisible").
 * Scope: Pure projections plus port-backed workload reads; no clock or mutation policy. It decides
 *   nothing the sequencer decides; where the two must agree (the park threshold, the in-flight
 *   phases, `consecutiveFailures`) it reuses the sequencer's own definitions.
 * Invariants:
 *   - DERIVED_NOT_STORED: `releaseState` reads terminal admission refusal plus attempt phases; there is no
 *     state column to drift from the sequencer's truth.
 *     `admissionRefusal` exposes the terminal verdict independently of recovery or serving phase.
 *   - STATE_TABLE (the release the workload's desired row points at — `current`):
 *       active       an attempt of the release is in phase `active` (it serves).
 *       deploying    an attempt is mid-flight (`planned|created|proving|proven`), OR any attempt of the
 *                    workload is `closing` (the sequencer never starts a paid create over an
 *                    unconfirmed close).
 *       parked       no attempt serves or is mid-flight and the sequencer recorded its park verdict
 *                    (`alert/release_parked` step): no further paid create until a NEW release. The
 *                    verdict wins over a third attempt that is still `closing`. A failure count alone
 *                    is not a park: the sequencer writes its verdict on the tick after the limit.
 *       queued       the release has no attempt yet (the sequencer has not picked it up).
 *       failed       the newest attempt failed (or its live lease was lost) and fewer than
 *                    `maxFailedAttempts` have failed: the sequencer will plan the next attempt.
 *     A release the desired row no longer points at is `superseded` whatever it did; `activatedAt`
 *     still says whether it ever served, and `serving: true` says it STILL backs the live lease
 *     (a newer release that is deploying, failed or parked leaves the old one serving).
 *   - LEAD_TIME: `leadTimeMs = activatedAt - recordedAt` (intent recorded -> first activation); null
 *     until the release first activates.
 *   - TOLERANT_OF_OLD_ROWS: an attempt that predates the timeline reads as an empty `steps[]`.
 * Side-effects: IO (read-only store through the injected port)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/sequencer.ts, task.5400
 * @public
 */

import type {
  DeployAttemptView,
  DeployReleaseDetail,
  DeployReleaseState,
  DeployReleaseTimeline,
  DeployWorkloadsRead,
  DeployWorkloadView,
} from "@/contracts/deploy.workloads.v1.contract";
import {
  type AttemptRow,
  consecutiveFailures,
  type DesiredRow,
  IN_FLIGHT_PHASES,
  type ReleaseRow,
  type StorePort,
} from "@/ports";
import { DEFAULT_SEQUENCER_CONFIG } from "./sequencer";

/** How many recent attempts the workload list carries (unchanged from the pre-timeline read). */
export const RECENT_ATTEMPTS = 10;

const iso = (d: Date | undefined): string | null =>
  d instanceof Date ? d.toISOString() : null;

const ms = (iso: string | null): number | null =>
  iso === null ? null : Date.parse(iso);

export function toAttemptView(a: AttemptRow): DeployAttemptView {
  return {
    id: a.id,
    releaseId: a.releaseId,
    attempt: a.attempt,
    cogniKey: a.cogniKey,
    externalName: a.externalName ?? null,
    provider: a.provider ?? null,
    endpoints: [...(a.endpoints ?? [])],
    phase: a.phase,
    error: a.error ?? null,
    unhealthySince: iso(a.unhealthySince),
    createdAt: iso(a.createdAt),
    leasedAt: iso(a.leasedAt),
    updatedAt: iso(a.updatedAt),
    steps: (a.steps ?? []).map((s) => ({ ...s })),
    ...(a.activatedAt ? { activatedAt: a.activatedAt.toISOString() } : {}),
    ...(a.transport ? { transport: a.transport } : {}),
  };
}

/**
 * Derive one release's state and timeline.
 *
 * `attemptsNewestFirst` is EVERY attempt of the workload (the store's `attemptsFor` order); the
 * release's own attempts are selected here, the whole set is needed for the `closing` rule.
 */
export function deriveReleaseTimeline(input: {
  readonly release: Pick<
    ReleaseRow,
    "id" | "sourceSha" | "admissionRefusal"
  > & {
    readonly createdAt?: Date | undefined;
  };
  readonly currentReleaseId: string | undefined;
  readonly attemptsNewestFirst: readonly AttemptRow[];
  readonly maxFailedAttempts?: number;
}): DeployReleaseTimeline {
  const max =
    input.maxFailedAttempts ?? DEFAULT_SEQUENCER_CONFIG.maxFailedAttempts;
  const all = input.attemptsNewestFirst;
  const ofRelease = all.filter((a) => a.releaseId === input.release.id);
  const current = input.currentReleaseId === input.release.id;

  const recordedAt = iso(input.release.createdAt);
  const oldestFirst = [...ofRelease].reverse();
  const startedAt = iso(oldestFirst[0]?.createdAt);

  // First activation: the earliest write-once `activatedAt` (task.5442), else the `activated` step; a
  // still-active attempt with neither (it predates both) falls back to its last phase change.
  let activatedAt: string | null = null;
  for (const a of oldestFirst) {
    const at =
      iso(a.activatedAt) ??
      (a.steps ?? []).find((s) => s.step === "activated" && s.outcome === "ok")
        ?.at;
    if (at) {
      activatedAt = at;
      break;
    }
  }
  const servingAttempt = ofRelease.find((a) => a.phase === "active");
  if (activatedAt === null && servingAttempt)
    activatedAt = iso(servingAttempt.updatedAt);
  // The sequencer's own park verdict, persisted on the release's newest attempt as an
  // `alert/release_parked` step. It wins over a still-`closing` third attempt.
  const parkedByStep = ofRelease.some((a) =>
    (a.steps ?? []).some(
      (s) => s.step === "alert" && s.outcome === "release_parked"
    )
  );

  const base = {
    releaseId: input.release.id,
    sourceSha: input.release.sourceSha,
    // Keep terminal admission visible even while recovery is deploying/closing, or a legacy
    // serving attempt still owns traffic. Attempts remain the independent recovery projection.
    admissionRefusal: input.release.admissionRefusal ?? null,
    admissionRefusedAt: input.release.admissionRefusal?.at ?? null,
    current,
    /** True when an attempt of THIS release backs the workload's live lease (any release). */
    serving: servingAttempt !== undefined,
    recordedAt,
    startedAt,
    activatedAt,
    leadTimeMs:
      activatedAt !== null && recordedAt !== null
        ? Math.max(0, (ms(activatedAt) ?? 0) - (ms(recordedAt) ?? 0))
        : null,
  };

  const done = (
    releaseState: DeployReleaseState,
    parkedReason: string | null = null
  ): DeployReleaseTimeline => ({ ...base, releaseState, parkedReason });

  if (!current) return done("superseded");
  if (servingAttempt) return done("active");
  if (ofRelease.some((a) => IN_FLIGHT_PHASES.includes(a.phase)))
    return done("deploying");
  const failures = consecutiveFailures(ofRelease);
  if (!parkedByStep && all.some((a) => a.phase === "closing"))
    return done("deploying");
  if (input.release.admissionRefusal)
    return done("parked", input.release.admissionRefusal.reason);
  // PARK_IS_THE_SEQUENCER'S_VERDICT: only the sequencer's own `release_parked` step parks a release. It
  // writes that step on the tick after the limit, so until then a count alone is `failed`.
  if (parkedByStep) {
    const last = ofRelease[0]?.error ?? "no error recorded";
    return done(
      "parked",
      `${Math.max(failures, max)} consecutive failed attempts; last: ${last}`.slice(
        0,
        600
      )
    );
  }
  if (ofRelease.length === 0) return done("queued");
  return done("failed");
}

/** One row of `GET /deploy/workloads`: the desired release's state plus its attempt timelines. */
export function buildWorkloadView(input: {
  readonly desired: Pick<DesiredRow, "workload" | "state" | "releaseId">;
  readonly release:
    | (Pick<ReleaseRow, "sourceSha"> & Partial<ReleaseRow>)
    | undefined;
  readonly attemptsNewestFirst: readonly AttemptRow[];
}): DeployWorkloadView {
  const { desired, release, attemptsNewestFirst } = input;
  const t = release?.sourceSha
    ? deriveReleaseTimeline({
        release: {
          id: desired.releaseId,
          sourceSha: release.sourceSha,
          createdAt: release.createdAt,
          admissionRefusal: release.admissionRefusal,
        },
        currentReleaseId: desired.releaseId,
        attemptsNewestFirst,
      })
    : undefined;
  const active = attemptsNewestFirst.find((a) => a.phase === "active");
  return {
    workload: desired.workload,
    desired: {
      state: desired.state,
      releaseId: desired.releaseId,
      sourceSha: release?.sourceSha,
      releaseState: t?.releaseState ?? "failed",
      parkedReason: t?.parkedReason ?? null,
      admissionRefusal: t?.admissionRefusal ?? null,
      admissionRefusedAt: t?.admissionRefusedAt ?? null,
      recordedAt: t?.recordedAt ?? null,
      startedAt: t?.startedAt ?? null,
      activatedAt: t?.activatedAt ?? null,
      leadTimeMs: t?.leadTimeMs ?? null,
      serving: t?.serving ?? false,
    },
    // The release backing the live lease; differs from `desired.releaseId` while a newer release
    // is deploying, failed or parked (the old one is `superseded` + `serving`).
    servingReleaseId: active?.releaseId ?? null,
    active: active ? toAttemptView(active) : null,
    recentAttempts: attemptsNewestFirst
      .slice(0, RECENT_ATTEMPTS)
      .map(toAttemptView),
  };
}

/**
 * `GET /deploy/workloads/releases/{releaseId}`: one release's state, timestamps and every attempt of
 * it with its step timeline (oldest attempt first, so the page reads as a story). Reads the workload's
 * newest 200 attempts (the store's bound), so an ancient release may show fewer attempts than it had.
 */
export function buildReleaseDetail(input: {
  readonly release: ReleaseRow;
  readonly desired: Pick<DesiredRow, "state" | "releaseId"> | undefined;
  readonly attemptsNewestFirst: readonly AttemptRow[];
}): DeployReleaseDetail {
  const { release, desired, attemptsNewestFirst } = input;
  return {
    nodeId: release.nodeId,
    env: release.env as DeployReleaseDetail["env"],
    workload: release.workload,
    desiredState: desired?.state ?? null,
    release: deriveReleaseTimeline({
      release,
      currentReleaseId: desired?.releaseId,
      attemptsNewestFirst,
    }),
    attempts: attemptsNewestFirst
      .filter((a) => a.releaseId === release.id)
      .reverse()
      .map(toAttemptView),
  };
}

/** Read the same durable workload projection for the node deploy-state surface. */
export async function readNodeDeployWorkloads(
  store: StorePort,
  nodeId: string,
  environments: readonly DeployWorkloadsRead["env"][]
): Promise<DeployWorkloadsRead[]> {
  return Promise.all(
    environments.map(async (env) => {
      const desired = (await store.listDesired(env)).filter(
        (row) => row.nodeId === nodeId
      );
      return {
        nodeId,
        env,
        workloads: await Promise.all(
          desired.map(async (row) =>
            buildWorkloadView({
              desired: row,
              release: await store.getRelease(row.releaseId),
              attemptsNewestFirst: await store.attemptsFor(row),
            })
          )
        ),
      };
    })
  );
}
