// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/experiments/akash-blue-green/scorecard`
 * Purpose: spike.5001 verdict for one measured blue/green release (or cutover cycle). Joins the
 *   public probe log with the release evidence the verifier collected (chain lease snapshots,
 *   actuator Loki timestamps, operator deploy-state) and evaluates the pre-registered pass
 *   criteria. Also aggregates many cycles into p50/p95 timings for the ten-cycle scorecard.
 * Scope: pure functions over recorded evidence plus a thin file-reading CLI. No network, no
 *   mutation, no deployment policy.
 * Invariants:
 *   - MISSING_EVIDENCE_FAILS: a criterion that cannot be evaluated fails; it never passes.
 *   - ALL_CRITERIA_AND: a release passes only if every criterion passes.
 *   - PROBE_COVERS_WINDOW: probes must start >= 60s before trigger, end >= 120s after the old
 *     lease closes, and never stall longer than `maxProbeGapMs`.
 * Side-effects: none in the library; the CLI reads two files and prints the verdict.
 * Links: knowledge akash-promotion-north-star (invariants 6, 9, 10), work item spike.5001.
 * @internal — measurement code, not shipped to production
 */

import { readFileSync } from "node:fs";

import type { LeaseSnapshot } from "./lease-audit";
import { type ProbeSample, summarize } from "./probe";

export interface LeaseRef {
  readonly cogniKey: string;
  readonly dseq: string;
}

/** Everything the verifier observed for one release, each timestamp as ISO-8601. */
export interface ReleaseEvidence {
  readonly label: string;
  readonly host: string;
  readonly incumbentSha: string;
  readonly releaseSha: string;
  /** Operator API trigger (flight/promote) 2xx response time. */
  readonly triggeredAt?: string;
  readonly oldLease?: LeaseRef;
  readonly newLease?: LeaseRef & { readonly firstObservedAt?: string };
  /** New lease proved serving the release SHA directly, before canonical traffic. */
  readonly provedAt?: string;
  /** Canonical DNS/edge record observed pointing at the new lease's target. */
  readonly dnsCutoverAt?: string;
  readonly dnsCutoverSource?: string;
  readonly oldLeaseClosedAt?: string;
  /** Close operations observed for the old lease (actuator events / chain). */
  readonly oldLeaseCloseCount?: number;
  /** Paid create operations observed for the new revision's idempotence key. */
  readonly paidCreateCount?: number;
  readonly leaseAuditBefore?: LeaseSnapshot;
  readonly leaseAuditAfter?: LeaseSnapshot;
  /** Operator deploy-state `orphans.length` before/after. */
  readonly ledgerOrphansBefore?: number;
  readonly ledgerOrphansAfter?: number;
  /** Cycles only: edge repoint to the retained incumbent. */
  readonly rollback?: {
    readonly startedAt?: string;
    readonly restoredAt?: string;
  };
}

export interface Check {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface Timings {
  readonly triggerToNewLeaseMs?: number | undefined;
  readonly newLeaseToProvedMs?: number | undefined;
  /** Proved -> first public sample serving the release SHA. */
  readonly cutoverMs?: number | undefined;
  readonly triggerToPublicShaMs?: number | undefined;
  /** New lease first observed -> old lease closed (two-lease overlap). */
  readonly overlapMs?: number | undefined;
  readonly rollbackMs?: number | undefined;
}

export interface Scorecard {
  readonly label: string;
  readonly pass: boolean;
  readonly checks: readonly Check[];
  readonly timings: Timings;
  readonly probe: ReturnType<typeof summarize> & {
    readonly firstReleaseShaAt?: string;
    readonly lastIncumbentShaAt?: string;
    readonly shaFlips: number;
  };
}

export const SCORECARD_DEFAULTS = {
  preTriggerMs: 60_000,
  postCloseMs: 120_000,
  maxProbeGapMs: 2_000,
  rollbackSloMs: 120_000,
  cutoverSloMs: 300_000,
} as const;

/** b - a in ms, or undefined when either side is missing or unparseable. Pure. */
export function elapsedMs(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? undefined : y - x;
}

const fmt = (ms?: number) =>
  ms === undefined ? "missing" : `${(ms / 1000).toFixed(1)}s`;

export function scoreRelease(
  samplesIn: readonly ProbeSample[],
  ev: ReleaseEvidence,
  opts: { requireRollback?: boolean } & Partial<typeof SCORECARD_DEFAULTS> = {}
): Scorecard {
  const cfg = { ...SCORECARD_DEFAULTS, ...opts };
  const samples = [...samplesIn].sort((a, b) => a.at.localeCompare(b.at));
  const summary = summarize(samples);
  const checks: Check[] = [];

  const firstRelease = samples.find((s) => s.ok && s.sha === ev.releaseSha);
  const lastIncumbent = [...samples]
    .reverse()
    .find((s) => s.ok && s.sha === ev.incumbentSha);
  let shaFlips = 0;
  let prevSha: string | undefined;
  for (const s of samples) {
    if (!s.sha) continue;
    if (prevSha !== undefined && s.sha !== prevSha) shaFlips++;
    prevSha = s.sha;
  }

  // P1 new lease minted (chain truth: absent before, active after).
  const before = ev.leaseAuditBefore?.activeDeploymentDseqs;
  const after = ev.leaseAuditAfter?.activeDeploymentDseqs;
  const newDseq = ev.newLease?.dseq;
  checks.push({
    id: "P1_new_lease_minted",
    ok: Boolean(
      newDseq &&
        before &&
        after &&
        !before.includes(newDseq) &&
        after.includes(newDseq)
    ),
    detail:
      !newDseq || !before || !after
        ? "missing new lease or before/after chain audit"
        : `new ${ev.newLease?.cogniKey} dseq=${newDseq}; before=[${before.join(",")}] after=[${after.join(",")}]`,
  });

  // P2 exact SHA on the public host at the end of the window.
  const last = samples.at(-1);
  checks.push({
    id: "P2_public_exact_sha",
    ok: Boolean(firstRelease && last?.ok && last.sha === ev.releaseSha),
    detail: !last
      ? "no probe samples"
      : `last sample ${last.at} sha=${last.sha ?? "-"} ok=${last.ok}; expected ${ev.releaseSha}; first release-sha at ${firstRelease?.at ?? "never"}`,
  });

  // P3 DNS cutover observed before the old lease closed.
  const dnsBeforeClose = elapsedMs(ev.dnsCutoverAt, ev.oldLeaseClosedAt);
  checks.push({
    id: "P3_dns_cutover_before_old_close",
    ok: dnsBeforeClose !== undefined && dnsBeforeClose > 0,
    detail:
      dnsBeforeClose === undefined
        ? "missing dnsCutoverAt or oldLeaseClosedAt"
        : `dns ${ev.dnsCutoverAt} (${ev.dnsCutoverSource ?? "source unstated"}) -> close ${ev.oldLeaseClosedAt}: ${fmt(dnsBeforeClose)}`,
  });

  // P4 old lease closed exactly once and absent on chain afterward.
  const oldDseq = ev.oldLease?.dseq;
  checks.push({
    id: "P4_old_lease_closed_once",
    ok: Boolean(
      ev.oldLeaseCloseCount === 1 &&
        oldDseq &&
        after &&
        !after.includes(oldDseq)
    ),
    detail: `closeCount=${ev.oldLeaseCloseCount ?? "missing"}; old dseq=${oldDseq ?? "missing"} activeAfter=${oldDseq && after ? after.includes(oldDseq) : "unknown"}`,
  });

  // P5 zero failed requests (every non-SHA failure class).
  const { wrong_sha: wrongSha = 0, ...otherFailures } = summary.byClass;
  const nonShaFailures = Object.values(otherFailures).reduce(
    (a, b) => a + b,
    0
  );
  checks.push({
    id: "P5_zero_failed_requests",
    ok: summary.total > 0 && nonShaFailures === 0,
    detail:
      summary.total === 0
        ? "no probe samples"
        : `${nonShaFailures}/${summary.total} failed ${JSON.stringify(otherFailures)}${summary.firstFailureAt ? ` first=${summary.firstFailureAt}` : ""}`,
  });

  // P6 zero wrong-SHA, and no incumbent SHA served after the incumbent lease closed.
  const incumbentAfterClose = ev.oldLeaseClosedAt
    ? samples.filter(
        (s) => s.sha === ev.incumbentSha && s.at > (ev.oldLeaseClosedAt ?? "")
      ).length
    : undefined;
  checks.push({
    id: "P6_zero_wrong_sha",
    ok: summary.total > 0 && wrongSha === 0 && incumbentAfterClose === 0,
    detail: `wrong_sha=${wrongSha}; incumbentAfterClose=${incumbentAfterClose ?? "unknown (no close time)"}; shaFlips=${shaFlips}`,
  });

  // P7 one paid mutation for the new revision.
  checks.push({
    id: "P7_one_paid_mutation",
    ok: ev.paidCreateCount === 1,
    detail: `paidCreateCount=${ev.paidCreateCount ?? "missing"}`,
  });

  // P8 no orphan: chain after == before - old + new; ledger orphans zero after.
  let orphanOk = false;
  let orphanDetail = "missing before/after chain audit or lease refs";
  if (before && after && oldDseq && newDseq) {
    const expected = new Set(before.filter((d) => d !== oldDseq));
    expected.add(newDseq);
    const extra = after.filter((d) => !expected.has(d));
    const missing = [...expected].filter((d) => !after.includes(d));
    orphanOk =
      extra.length === 0 && missing.length === 0 && ev.ledgerOrphansAfter === 0;
    orphanDetail = `unexpectedActive=[${extra.join(",")}] missing=[${missing.join(",")}] ledgerOrphans ${ev.ledgerOrphansBefore ?? "?"}->${ev.ledgerOrphansAfter ?? "missing"}`;
  }
  checks.push({ id: "P8_no_orphan_lease", ok: orphanOk, detail: orphanDetail });

  // P9 probe evidence covers the whole window with no stall.
  const preMs = elapsedMs(summary.firstAt, ev.triggeredAt);
  const postMs = elapsedMs(ev.oldLeaseClosedAt, summary.lastAt);
  checks.push({
    id: "P9_probe_covers_window",
    ok:
      preMs !== undefined &&
      preMs >= cfg.preTriggerMs &&
      postMs !== undefined &&
      postMs >= cfg.postCloseMs &&
      summary.maxGapMs <= cfg.maxProbeGapMs,
    detail: `preTrigger=${fmt(preMs)} (>=${fmt(cfg.preTriggerMs)}) postClose=${fmt(postMs)} (>=${fmt(cfg.postCloseMs)}) maxGap=${summary.maxGapMs}ms (<=${cfg.maxProbeGapMs}ms)`,
  });

  const timings: Timings = {
    triggerToNewLeaseMs: elapsedMs(
      ev.triggeredAt,
      ev.newLease?.firstObservedAt
    ),
    newLeaseToProvedMs: elapsedMs(ev.newLease?.firstObservedAt, ev.provedAt),
    cutoverMs: elapsedMs(ev.provedAt, firstRelease?.at),
    triggerToPublicShaMs: elapsedMs(ev.triggeredAt, firstRelease?.at),
    overlapMs: elapsedMs(ev.newLease?.firstObservedAt, ev.oldLeaseClosedAt),
    rollbackMs: elapsedMs(ev.rollback?.startedAt, ev.rollback?.restoredAt),
  };

  if (opts.requireRollback) {
    checks.push({
      id: "P10_rollback_within_slo",
      ok:
        timings.rollbackMs !== undefined &&
        timings.rollbackMs <= cfg.rollbackSloMs,
      detail: `rollback ${fmt(timings.rollbackMs)} (SLO ${fmt(cfg.rollbackSloMs)})`,
    });
  }

  return {
    label: ev.label,
    pass: checks.every((c) => c.ok),
    checks,
    timings,
    probe: {
      ...summary,
      ...(firstRelease && { firstReleaseShaAt: firstRelease.at }),
      ...(lastIncumbent && { lastIncumbentShaAt: lastIncumbent.at }),
      shaFlips,
    },
  };
}

/** Nearest-rank percentile; undefined for an empty set. Pure. */
export function percentile(
  values: readonly number[],
  p: number
): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Ten-cycle rollup: p50/p95 per timing, total failures, and pass count. Pure. */
export function aggregate(cards: readonly Scorecard[]) {
  const keys: (keyof Timings)[] = [
    "triggerToNewLeaseMs",
    "newLeaseToProvedMs",
    "cutoverMs",
    "triggerToPublicShaMs",
    "overlapMs",
    "rollbackMs",
  ];
  const timings = Object.fromEntries(
    keys.map((k) => {
      const v = cards
        .map((c) => c.timings[k])
        .filter((x): x is number => x !== undefined);
      return [
        k,
        { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) },
      ];
    })
  );
  return {
    cycles: cards.length,
    passed: cards.filter((c) => c.pass).length,
    requests: cards.reduce((a, c) => a + c.probe.total, 0),
    failedRequests: cards.reduce((a, c) => a + c.probe.failures, 0),
    timings,
  };
}

export function formatScorecard(s: Scorecard): string {
  const t = s.timings;
  return [
    `${s.label}: ${s.pass ? "PASS" : "FAIL"}`,
    ...s.checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.id}: ${c.detail}`),
    `  timings: trigger->lease ${fmt(t.triggerToNewLeaseMs)} | lease->proved ${fmt(t.newLeaseToProvedMs)} | cutover ${fmt(t.cutoverMs)} | trigger->public ${fmt(t.triggerToPublicShaMs)} | overlap ${fmt(t.overlapMs)} | rollback ${fmt(t.rollbackMs)}`,
    `  probe: ${s.probe.total} req, ${s.probe.failures} failed, shas=${JSON.stringify(s.probe.shaCounts)}`,
  ].join("\n");
}

// pnpm tsx scripts/experiments/akash-blue-green/scorecard.ts <probe.jsonl> <evidence.json> [--require-rollback] [--json]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [probeFile, evidenceFile] = process.argv.slice(2);
  if (!probeFile || !evidenceFile) {
    console.error(
      "usage: scorecard.ts <probe.jsonl> <evidence.json> [--require-rollback] [--json]"
    );
    process.exit(2);
  }
  const samples = readFileSync(probeFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ProbeSample);
  const evidence = JSON.parse(
    readFileSync(evidenceFile, "utf8")
  ) as ReleaseEvidence;
  const card = scoreRelease(samples, evidence, {
    requireRollback: process.argv.includes("--require-rollback"),
  });
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(card, null, 2)
      : formatScorecard(card)
  );
  process.exit(card.pass ? 0 : 1);
}
