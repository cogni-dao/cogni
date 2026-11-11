// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lane-view`
 * Purpose: Project one deploy LANE (`{node, env, workload}`) into queue awareness and KPIs for a node
 *   developer: what serves now, what is in flight and who recorded it, which releases were superseded or
 *   parked in the last 24 hours (and who replaced them), and the lane's release success ratio, lead time
 *   p50/p90 and supersede count. Born of bug.5621: six supersedes and two parks in one night on one
 *   candidate-a lane were invisible until a human read the rows. task.5479 / story.5159.
 * Scope: Pure projection of rows the caller already read (the desired row, its release and attempts, and
 *   the lane's recent release facts). It decides nothing: no admission, no refusal, no write. The
 *   classification and the success / lead-time / percentile math are the delivery KPIs' own
 *   (`delivery-kpis.ts`), so the lane view and the fleet goal metrics cannot disagree about a release.
 * Invariants:
 *   - READ_ONLY: no clock, no IO, no mutation policy; `now` is an input.
 *   - LANE_SCOPED: only releases whose `workload` equals the lane's are read; a lane never counts another
 *     lane's releases.
 *   - SUPERSEDED_MEANS_REPLACED_BEFORE_FINISHING: a release that first activated is a success whatever
 *     replaced it later (the same rule as `classifyRelease`). Only a release replaced before it served or
 *     was parked counts as superseded. Its `endedAt` is the replacing release's `recordedAt`: the desired
 *     row moves to a newer release in the same transaction that records it, so successor = next release by
 *     `createdAt` in the lane.
 *   - PARKED_TIMED_BY_DURABLE_INSTANT: a park is timed by the write-once park instant only (never the
 *     repeating `release_parked` step), as in the delivery KPIs.
 *   - RATIO_UNKNOWN_IS_NULL: a window where nothing finished reports `successRatio: null`, never 0 or 1.
 * Side-effects: none
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/release-view.ts,
 *   features/node-deploy/delivery-kpis.ts, story.5159, bug.5621
 * @public
 */

import type {
  DeployLaneHistoryEntry,
  DeployLaneInFlight,
  DeployLaneServing,
  DeployLaneView,
  DeployLaneWindowKpis,
} from "@/contracts/deploy.workloads.v1.contract";
import type {
  AttemptRow,
  DeliveryReleaseFacts,
  DesiredRow,
  ReleaseRow,
} from "@/ports";
import {
  classifyRelease,
  percentile,
  summarizeReleases,
} from "./delivery-kpis";
import { buildWorkloadView } from "./release-view";

const HOUR_MS = 3_600_000;
const LANE_HISTORY_HOURS = 24;
const LANE_LONG_WINDOW_HOURS = 168;
/** Releases are read from this far back so one recorded before a window can still finish inside it. */
export const LANE_READ_LOOKBACK_HOURS = 2 * LANE_LONG_WINDOW_HOURS;

const sha8 = (sha: string): string => sha.slice(0, 8);

export interface LaneViewInput {
  readonly now: Date;
  readonly desired: Pick<DesiredRow, "workload" | "state" | "releaseId">;
  /** The desired release; undefined when its row is gone. */
  readonly desiredRelease: ReleaseRow | undefined;
  /** EVERY attempt of the lane, newest first (the store's `attemptsFor`). */
  readonly attemptsNewestFirst: readonly AttemptRow[];
  /** The release whose attempt serves (`servingReleaseId` of the workload view), when readable. */
  readonly servingRelease: ReleaseRow | undefined;
  /** Release facts read for the lane's node and env; other workloads are ignored. */
  readonly releases: readonly DeliveryReleaseFacts[];
}

interface Ended {
  readonly release: DeliveryReleaseFacts;
  readonly outcome: "superseded" | "parked";
  readonly endedAt: Date;
  readonly successor: DeliveryReleaseFacts | undefined;
}

/** Releases of the lane that ended without serving: replaced before finishing, or parked. */
function endedWithoutServing(
  sorted: readonly DeliveryReleaseFacts[],
  now: Date
): Ended[] {
  const out: Ended[] = [];
  const farPast = new Date(0);
  sorted.forEach((release, i) => {
    const o = classifyRelease(release, farPast, now);
    if (o.kind === "failure")
      out.push({
        release,
        outcome: "parked",
        endedAt: o.at,
        successor: undefined,
      });
    else if (o.kind === "superseded") {
      const successor = sorted[i + 1];
      if (successor)
        out.push({
          release,
          outcome: "superseded",
          endedAt: successor.createdAt,
          successor,
        });
    }
  });
  return out;
}

function windowKpis(
  sorted: readonly DeliveryReleaseFacts[],
  ended: readonly Ended[],
  now: Date,
  hours: number
): DeployLaneWindowKpis {
  const from = new Date(now.getTime() - hours * HOUR_MS);
  const s = summarizeReleases(sorted, from, now);
  const finished = s.success + s.failure;
  const lead = s.leadMs;
  return {
    windowHours: hours,
    activated: s.success,
    parked: s.failure,
    successRatio: finished > 0 ? s.success / finished : null,
    leadTimeP50Ms: lead.length > 0 ? Math.round(percentile(lead, 50)) : null,
    leadTimeP90Ms: lead.length > 0 ? Math.round(percentile(lead, 90)) : null,
    superseded: ended.filter(
      (e) =>
        e.outcome === "superseded" &&
        e.endedAt.getTime() >= from.getTime() &&
        e.endedAt.getTime() < now.getTime()
    ).length,
  };
}

export function buildLaneView(input: LaneViewInput): DeployLaneView {
  const { now, desired, desiredRelease, attemptsNewestFirst } = input;
  const sorted = input.releases
    .filter((r) => r.workload === desired.workload)
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.releaseId.localeCompare(b.releaseId)
    );
  const view = buildWorkloadView({
    desired,
    release: desiredRelease,
    attemptsNewestFirst,
  });

  const active = attemptsNewestFirst.find((a) => a.phase === "active");
  const serving: DeployLaneServing | null = view.servingReleaseId
    ? {
        releaseId: view.servingReleaseId,
        sourceSha: input.servingRelease?.sourceSha ?? null,
        sha8: input.servingRelease
          ? sha8(input.servingRelease.sourceSha)
          : null,
        requestedBy: input.servingRelease?.createdBy ?? null,
        servingSince:
          active?.activatedAt?.toISOString() ??
          active?.updatedAt?.toISOString() ??
          null,
      }
    : null;

  const state = view.desired.releaseState;
  const inFlightState =
    state === "queued" || state === "deploying" || state === "failed"
      ? state
      : null;
  const inFlight: DeployLaneInFlight | null =
    inFlightState &&
    desiredRelease &&
    desired.releaseId !== view.servingReleaseId
      ? {
          releaseId: desired.releaseId,
          sourceSha: desiredRelease.sourceSha,
          sha8: sha8(desiredRelease.sourceSha),
          state: inFlightState,
          attempts: attemptsNewestFirst.filter(
            (a) => a.releaseId === desired.releaseId
          ).length,
          recordedAt: view.desired.recordedAt,
          startedAt: view.desired.startedAt,
          requestedBy: desiredRelease.createdBy,
          waitingMs: Math.max(
            0,
            now.getTime() - desiredRelease.createdAt.getTime()
          ),
        }
      : null;

  const ended = endedWithoutServing(sorted, now);
  const historyFrom = now.getTime() - LANE_HISTORY_HOURS * HOUR_MS;
  const history24h: DeployLaneHistoryEntry[] = ended
    .filter(
      (e) =>
        e.endedAt.getTime() >= historyFrom &&
        e.endedAt.getTime() < now.getTime()
    )
    .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime())
    .map((e) => ({
      releaseId: e.release.releaseId,
      sourceSha: e.release.sourceSha,
      sha8: sha8(e.release.sourceSha),
      outcome: e.outcome,
      requestedBy: e.release.createdBy,
      recordedAt: e.release.createdAt.toISOString(),
      endedAt: e.endedAt.toISOString(),
      reason:
        e.outcome === "superseded" && e.successor
          ? `superseded by ${sha8(e.successor.sourceSha)} (${e.successor.createdBy}) before it finished`
          : ((e.release.releaseId === desired.releaseId
              ? view.desired.parkedReason
              : null) ??
            e.release.admissionRefusalReason ??
            "parked by the sequencer after consecutive failed attempts"),
      hadFailedAttempt: e.release.failedBeforeActivation,
      supersededBy: e.successor
        ? {
            releaseId: e.successor.releaseId,
            sha8: sha8(e.successor.sourceSha),
            requestedBy: e.successor.createdBy,
          }
        : null,
    }));

  return {
    workload: desired.workload,
    desiredState: desired.state,
    desired: {
      releaseId: desired.releaseId,
      sourceSha: view.desired.sourceSha ?? null,
      releaseState: state,
      parkedReason: view.desired.parkedReason,
    },
    serving,
    inFlight,
    history24h,
    kpis: {
      last24h: windowKpis(sorted, ended, now, LANE_HISTORY_HOURS),
      last7d: windowKpis(sorted, ended, now, LANE_LONG_WINDOW_HOURS),
    },
  };
}
