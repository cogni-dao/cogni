// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/candidate-backlog-kpis`
 * Purpose: The candidate queue KPI (task.5498, story.5159): `delivery.candidate-backlog@1` with
 *   `output: "backlog"` (open non-draft PRs whose head SHA never served on candidate-a) and
 *   `output: "wait_p90_hours"` (hours from a head SHA's CI green to its first activation on candidate-a; a SHA
 *   that never served waits until now). POST-to-serving lead time cannot see this queue: the wait is before the POST.
 * Scope: Pure classification and the calculator object. Reads go through `CandidateBacklogSourcePort` (GitHub,
 *   through the operator's existing App) and `DeliveryKpiSourcePort.releases` (the release store).
 * Invariants:
 *   - NEVER_SERVED_IS_BACKLOG: a head SHA is served when any release of the node on candidate-a (any workload,
 *     so a test env counts) has `sourceSha` equal to it and an attempt that is or was serving (`served`) or an
 *     activation instant. Everything else, including a SHA whose only release failed, is backlog.
 *   - WAIT_CANNOT_HIDE_THE_QUEUE: a served SHA waits `max(0, firstActivation - green)`; an unserved SHA with a
 *     CI green waits `now - green`. A SHA with no CI green yet (pending, failed, absent) has no wait sample; it
 *     is in the backlog and named in evidence (`ci_not_green`). A served SHA with no activation instant is
 *     `untimed` and is not sampled.
 *   - BOUNDED: at most `MAX_CANDIDATE_PRS` PRs, one PR list read, one check-suites read per head SHA (only for
 *     `wait_p90_hours`), one release read. More open PRs, a truncated release read or a head whose suites did not
 *     fit is an unavailable reading.
 *   - UNKNOWN_IS_A_RESULT: no repo, an unreadable GitHub (the read throws; the engine records `source_failed`),
 *     truncation or no wait sample yields an unavailable reading with a reason, never 0.
 *   - OPERATOR_IS_UNAVAILABLE: the operator's own candidate flights are GitHub workflow runs; no store records
 *     the SHAs it flighted. Its reading is unavailable (`operator_flights_not_recorded`) and does not block node
 *     lanes. TODO(task.5498): read the operator's flight history once the sequencer or the flight route records it.
 *   - SERVED_HAS_NO_WINDOW: served-ness is looked up by the open head SHAs themselves (`scope.sourceShas`) from the
 *     epoch, so a long-open PR whose head served long ago is not backlog. `days` (default 28) bounds only the WAIT
 *     samples: a served head whose first activation is older than `days` is left out of them (`outside_window`).
 *     Unserved heads are always sampled.
 *   - SNAPSHOT: the reading is "now".
 *   - IDS_USE_DASHES: the id matches `MetricSpecSchema.calculatorId`.
 * Side-effects: none (calculators call the injected sources)
 * Links: ports/candidate-backlog.port.ts, features/node-deploy/delivery-kpis.ts, bootstrap/capabilities/goal-metrics.ts
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type {
  CandidateBacklogSourcePort,
  CandidateOpenPr,
  CandidateRepo,
  DeliveryKpiSourcePort,
  DeliveryReleaseFacts,
} from "@/ports";
import { percentile } from "./delivery-kpis";

export const CANDIDATE_BACKLOG_ID = "delivery.candidate-backlog@1";
/** The env this KPI is about. */
export const CANDIDATE_ENV = "candidate-a";
/** Most PRs one reading covers. */
export const MAX_CANDIDATE_PRS = 100;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_EVIDENCE = 20;
/** Most releases one reading covers. */
const MAX_RELEASES = 5000;

const params = z.strictObject({
  nodeId: z.uuid(),
  output: z.enum(["backlog", "wait_p90_hours"]),
  /** Wait-sample window only: a head first served longer ago than this is not a wait sample. */
  days: z.number().int().min(1).max(28).default(28),
});

/** `owner/repo` of a catalog `source_repo` URL, or undefined. */
export function parseSourceRepo(url: unknown): CandidateRepo | undefined {
  if (typeof url !== "string") return undefined;
  const m =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(
      url.trim()
    );
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : undefined;
}

/** First activation instant of each head SHA the node served on candidate-a; `null` = served, untimed. */
export function firstServed(
  releases: readonly DeliveryReleaseFacts[]
): Map<string, Date | null> {
  const out = new Map<string, Date | null>();
  for (const r of releases) {
    const instant = r.activatedAt ?? r.activatedStepAt;
    if (!r.served && !instant) continue;
    const sha = r.sourceSha.toLowerCase();
    const prior = out.get(sha);
    if (instant) {
      if (!prior || instant.getTime() < prior.getTime()) out.set(sha, instant);
    } else if (prior === undefined) out.set(sha, null);
  }
  return out;
}

const unknown = (
  unit: string,
  reason: NonNullable<MetricSample["reason"]>,
  evidenceRefs: string[],
  asOf: Date
): MetricSample => ({
  value: 0,
  unit,
  complete: false,
  reason,
  sourceWatermarks: [{ source: "github_pulls", asOf: asOf.toISOString() }],
  evidenceRefs,
});

export interface CandidateBacklogOptions {
  /** `source_repo` of the node's catalog row; undefined when the node has none. */
  readonly repoOf: (nodeId: string) => Promise<CandidateRepo | undefined>;
  /** This operator's own node id: its candidate flights are not recorded in the store (OPERATOR_IS_UNAVAILABLE). */
  readonly operatorNodeId: string | undefined;
  /** Undefined = the review App is not configured: every reading is unavailable. */
  readonly github: CandidateBacklogSourcePort | undefined;
  readonly now?: () => number;
}

export function createCandidateBacklogCalculators(
  releases: DeliveryKpiSourcePort,
  options: CandidateBacklogOptions
): MetricCalculator[] {
  const now = options.now ?? Date.now;
  const calculator: MetricCalculator = {
    id: CANDIDATE_BACKLOG_ID,
    unit: "prs",
    unitFor: (p) => (params.parse(p).output === "backlog" ? "prs" : "h"),
    display: "volume",
    displayFor: (p) =>
      params.parse(p).output === "backlog" ? "volume" : "progress",
    paramsSchema: params,
    budget: {
      timeoutMs: 60_000,
      maxSourceCalls: MAX_CANDIDATE_PRS + 2,
      maxRows: MAX_RELEASES,
      maxResponseBytes: 8_388_608,
    },
    async compute(raw, ctx) {
      const p = params.parse(raw);
      const unit = p.output === "backlog" ? "prs" : "h";
      const asOf = new Date(now());
      const head = [`candidate:node=${p.nodeId},env=${CANDIDATE_ENV}`];
      if (p.nodeId === options.operatorNodeId)
        return unknown(
          unit,
          "calculator_unavailable",
          [...head, "candidate:reason=operator_flights_not_recorded"],
          asOf
        );
      const repo = await options.repoOf(p.nodeId);
      if (!repo)
        return unknown(
          unit,
          "incomplete_or_invalid_source",
          [...head, "candidate:reason=no_source_repo"],
          asOf
        );
      const github = options.github;
      if (!github)
        return unknown(
          unit,
          "calculator_unavailable",
          [...head, "candidate:reason=github_app_not_configured"],
          asOf
        );
      const repoRef = `candidate:repo=${repo.owner}/${repo.repo}`;

      // One PR list read. A throw (GitHub unreadable) propagates: the engine records `source_failed`.
      const open = await ctx.read((signal) =>
        github.openPullRequests({ repo, maxPrs: MAX_CANDIDATE_PRS, signal })
      );
      if (open.truncated || open.prs.length > MAX_CANDIDATE_PRS)
        return unknown(
          unit,
          "incomplete_or_invalid_source",
          [
            ...head,
            repoRef,
            `candidate:reason=more_than_${MAX_CANDIDATE_PRS}_open_prs`,
          ],
          open.asOf
        );

      const nowMs = now();
      // SERVED_HAS_NO_WINDOW: look the heads up by sha, from the epoch. No heads: nothing to look up.
      const heads = [...new Set(open.prs.map((pr) => pr.headSha))];
      const read =
        heads.length === 0
          ? { rows: [], truncated: false, asOf: open.asOf }
          : await ctx.read((signal, budget) =>
              releases.releases({
                recordedFrom: new Date(0),
                to: new Date(nowMs + 1000),
                scope: {
                  nodeId: p.nodeId,
                  env: CANDIDATE_ENV,
                  sourceShas: heads,
                },
                maxRows: budget.maxRows,
                signal,
              })
            );
      const watermarks = [
        { source: "github_pulls", asOf: open.asOf.toISOString() },
        { source: "node_workload_releases", asOf: read.asOf.toISOString() },
      ];
      if (read.truncated)
        return {
          ...unknown(
            unit,
            "incomplete_or_invalid_source",
            [...head, repoRef, "candidate:reason=release_read_truncated"],
            open.asOf
          ),
          sourceWatermarks: watermarks,
        };

      const served = firstServed(read.rows);
      const unserved = open.prs.filter((pr) => !served.has(pr.headSha));
      const evidence = [
        ...head,
        repoRef,
        `candidate:open_prs=${open.prs.length},unserved=${unserved.length}`,
        ...unserved
          .slice(0, MAX_EVIDENCE)
          .map(
            (pr) =>
              `candidate:unserved=pr${pr.number}@${pr.headSha.slice(0, 7)}`
          ),
      ];
      if (p.output === "backlog")
        return {
          value: unserved.length,
          unit,
          complete: true,
          sourceWatermarks: watermarks,
          evidenceRefs: evidence,
        };

      // wait_p90_hours: one check-suites read per head SHA.
      const waits: number[] = [];
      let notGreen = 0;
      let untimed = 0;
      let outsideWindow = 0;
      let incomplete = 0;
      for (const pr of open.prs as readonly CandidateOpenPr[]) {
        const ci = await ctx.read((signal) =>
          github.ciGreenAt({ repo, headSha: pr.headSha, signal })
        );
        if (ci.incomplete) {
          incomplete++;
          continue;
        }
        if (!ci.green) {
          notGreen++;
          continue;
        }
        const firstServe = served.get(pr.headSha);
        if (firstServe === null) {
          untimed++;
          continue;
        }
        if (firstServe && nowMs - firstServe.getTime() > p.days * DAY_MS) {
          outsideWindow++;
          continue;
        }
        const end = firstServe ? firstServe.getTime() : nowMs;
        waits.push(Math.max(0, end - ci.green.getTime()) / HOUR_MS);
      }
      const waitEvidence = [
        ...evidence,
        `candidate:wait_samples=${waits.length},ci_not_green=${notGreen},untimed=${untimed},outside_window=${outsideWindow},ci_incomplete=${incomplete}`,
      ];
      if (incomplete > 0)
        return {
          ...unknown(
            unit,
            "incomplete_or_invalid_source",
            waitEvidence,
            open.asOf
          ),
          sourceWatermarks: watermarks,
        };
      if (waits.length === 0)
        return {
          ...unknown(unit, "zero_denominator", waitEvidence, open.asOf),
          sourceWatermarks: watermarks,
        };
      return {
        value: Math.round(percentile(waits, 90) * 10) / 10,
        unit,
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: waitEvidence,
      };
    },
  };
  return [calculator];
}
