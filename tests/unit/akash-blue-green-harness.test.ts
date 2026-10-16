// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/akash-blue-green-harness`
 * Purpose: Pins the spike.5001 measurement rules: request classification, probe cadence,
 *   chain lease snapshot parsing, and the pre-registered release criteria (missing evidence fails).
 * Scope: Pure functions and injected fetch fakes; does not touch the network.
 * Invariants: MISSING_EVIDENCE_FAILS; classify() is the single success rule.
 * Side-effects: none
 * Links: scripts/experiments/akash-blue-green/*
 * @internal
 */

import { describe, expect, it } from "vitest";

import { snapshotLeases } from "../../scripts/experiments/akash-blue-green/lease-audit";
import {
  classify,
  classifyFetchError,
  type ProbeSample,
  runProbe,
  summarize,
} from "../../scripts/experiments/akash-blue-green/probe";
import {
  aggregate,
  percentile,
  type ReleaseEvidence,
  scoreRelease,
} from "../../scripts/experiments/akash-blue-green/scorecard";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

describe("classify", () => {
  const allowed = [OLD, NEW];
  it("accepts a 2xx serving an allowed SHA", () => {
    expect(
      classify({
        status: 200,
        version: { buildSha: NEW },
        allowedShas: allowed,
      })
    ).toEqual({
      ok: true,
    });
  });
  it("flags a SHA outside the allowed set as wrong_sha", () => {
    expect(
      classify({
        status: 200,
        version: { buildSha: "c".repeat(40) },
        allowedShas: allowed,
      }).failure
    ).toBe("wrong_sha");
  });
  it("flags 5xx and Cloudflare 52x as http_5xx, other non-2xx as http_non2xx", () => {
    expect(classify({ status: 502, allowedShas: allowed }).failure).toBe(
      "http_5xx"
    );
    expect(classify({ status: 521, allowedShas: allowed }).failure).toBe(
      "http_5xx"
    );
    expect(classify({ status: 404, allowedShas: allowed }).failure).toBe(
      "http_non2xx"
    );
  });
  it("flags a 2xx without a readable buildSha as invalid_body", () => {
    expect(classify({ status: 200, allowedShas: allowed }).failure).toBe(
      "invalid_body"
    );
  });
  it("maps thrown errors to timeout, tls, or connection", () => {
    expect(
      classifyFetchError(
        Object.assign(new Error("x"), { name: "TimeoutError" })
      )
    ).toBe("timeout");
    expect(
      classifyFetchError(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
        })
      )
    ).toBe("tls");
    expect(
      classifyFetchError(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        })
      )
    ).toBe("connection");
  });
});

describe("runProbe", () => {
  it("records every tick against an injected fetch and classifies each", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 2) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ buildSha: n < 3 ? OLD : NEW }), {
        status: 200,
        headers: { "cf-ray": `ray-${n}` },
      });
    }) as typeof fetch;
    const samples = await runProbe({
      url: "https://node.example",
      allowedShas: [OLD, NEW],
      ratePerSec: 50,
      durationMs: 100,
      fetchImpl,
    });
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples.filter((s) => s.failure === "http_5xx")).toHaveLength(1);
    expect(samples[0]?.cfRay).toBe("ray-1");
    const sum = summarize(samples);
    expect(sum.failures).toBe(1);
    expect(sum.shaCounts[OLD]).toBe(1);
  });
});

describe("snapshotLeases", () => {
  it("lists only chain-active deployments and leases", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain("filters.state=active");
      const body = u.includes("/deployments/list")
        ? { deployments: [{ deployment: { id: { dseq: "200" } } }] }
        : {
            leases: [
              {
                lease: {
                  id: { dseq: "200", gseq: 1, oseq: 1, provider: "akash1prov" },
                  state: "active",
                },
              },
            ],
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const snap = await snapshotLeases("akash1owner", {
      fetchImpl,
      now: () => new Date("2026-10-16T00:00:00Z"),
    });
    expect(snap.activeDeploymentDseqs).toEqual(["200"]);
    expect(snap.activeLeases[0]).toMatchObject({
      dseq: "200",
      provider: "akash1prov",
    });
  });
});

function sampleSeries(
  fromIso: string,
  count: number,
  shaAt: (i: number) => string
) {
  const t0 = Date.parse(fromIso);
  return Array.from(
    { length: count },
    (_, i): ProbeSample => ({
      seq: i,
      at: new Date(t0 + i * 500).toISOString(),
      ok: true,
      status: 200,
      sha: shaAt(i),
      latencyMs: 40,
    })
  );
}

const T0 = "2026-10-16T10:00:00.000Z";
const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();

function goodEvidence(): ReleaseEvidence {
  return {
    label: "K2 candidate-a flight",
    host: "spawny-boi.cogni-testing.org",
    incumbentSha: OLD,
    releaseSha: NEW,
    triggeredAt: at(60),
    oldLease: { cogniKey: "xcw:ns:node:1", dseq: "100" },
    newLease: {
      cogniKey: "xcw:ns:node:2",
      dseq: "200",
      firstObservedAt: at(120),
    },
    provedAt: at(200),
    dnsCutoverAt: at(210),
    dnsCutoverSource: "loki",
    oldLeaseClosedAt: at(260),
    oldLeaseCloseCount: 1,
    paidCreateCount: 1,
    leaseAuditBefore: {
      at: at(0),
      owner: "o",
      activeDeploymentDseqs: ["100"],
      activeLeases: [],
    },
    leaseAuditAfter: {
      at: at(400),
      owner: "o",
      activeDeploymentDseqs: ["200"],
      activeLeases: [],
    },
    ledgerOrphansBefore: 0,
    ledgerOrphansAfter: 0,
  };
}

// 0s..400s at 2 rps; release SHA from 215s.
const goodSamples = () => sampleSeries(T0, 800, (i) => (i < 430 ? OLD : NEW));

describe("scoreRelease", () => {
  it("passes a clean blue/green release and computes timings", () => {
    const card = scoreRelease(goodSamples(), goodEvidence());
    expect(card.checks.filter((c) => !c.ok)).toEqual([]);
    expect(card.pass).toBe(true);
    expect(card.timings.triggerToPublicShaMs).toBe(155_000);
    expect(card.timings.cutoverMs).toBe(15_000);
    expect(card.timings.overlapMs).toBe(140_000);
    expect(card.probe.shaFlips).toBe(1);
  });

  it("fails when evidence is missing rather than passing", () => {
    const {
      dnsCutoverAt: _d,
      paidCreateCount: _p,
      ...partial
    } = goodEvidence();
    const card = scoreRelease(goodSamples(), partial);
    const failed = card.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual([
      "P3_dns_cutover_before_old_close",
      "P7_one_paid_mutation",
    ]);
    expect(card.pass).toBe(false);
  });

  it("fails on a single 521 or a stale incumbent SHA after close", () => {
    const samples = goodSamples();
    samples[500] = {
      ...samples[500],
      ok: false,
      failure: "http_5xx",
      status: 521,
    } as ProbeSample;
    samples[700] = { ...samples[700], sha: OLD } as ProbeSample;
    const card = scoreRelease(samples, goodEvidence());
    const failed = card.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toContain("P5_zero_failed_requests");
    expect(failed).toContain("P6_zero_wrong_sha");
  });

  it("fails when the old lease closes before DNS cutover or leaves an orphan", () => {
    const ev = {
      ...goodEvidence(),
      dnsCutoverAt: at(270),
      leaseAuditAfter: {
        at: at(400),
        owner: "o",
        activeDeploymentDseqs: ["100", "200"],
        activeLeases: [],
      },
    };
    const failed = scoreRelease(goodSamples(), ev)
      .checks.filter((c) => !c.ok)
      .map((c) => c.id);
    expect(failed).toEqual(
      expect.arrayContaining([
        "P3_dns_cutover_before_old_close",
        "P4_old_lease_closed_once",
        "P8_no_orphan_lease",
      ])
    );
  });

  it("fails when the probe did not cover the window", () => {
    const card = scoreRelease(goodSamples().slice(200), goodEvidence());
    expect(card.checks.find((c) => c.id === "P9_probe_covers_window")?.ok).toBe(
      false
    );
  });

  it("enforces rollback <=120s only when required", () => {
    const ev = {
      ...goodEvidence(),
      rollback: { startedAt: at(300), restoredAt: at(430) },
    };
    expect(scoreRelease(goodSamples(), ev).pass).toBe(true);
    const card = scoreRelease(goodSamples(), ev, { requireRollback: true });
    expect(
      card.checks.find((c) => c.id === "P10_rollback_within_slo")?.ok
    ).toBe(false);
  });
});

describe("aggregate", () => {
  it("computes nearest-rank p50/p95 across cycles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeUndefined();
    const card = scoreRelease(goodSamples(), goodEvidence());
    const roll = aggregate([card, card]);
    expect(roll).toMatchObject({ cycles: 2, passed: 2, failedRequests: 0 });
    expect(roll.timings.cutoverMs).toEqual({ n: 2, p50: 15_000, p95: 15_000 });
  });
});
