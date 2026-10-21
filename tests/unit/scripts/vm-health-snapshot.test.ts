// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/vm-health-snapshot`
 * Purpose: Pin the VM health grading an agent relies on to answer "is the VM healthy" without a dashboard.
 * Scope: Pure `evaluate()` over metric snapshots. Does not call Grafana.
 * Invariants:
 *   - MISSING_IS_NOT_HEALTHY: stale/absent telemetry grades RED.
 *   - the 2026-10-21 pre-fix production snapshot grades RED; the post-fix snapshot grades GREEN.
 * Side-effects: none
 * Links: scripts/vm-health-snapshot.mjs, .claude/skills/vm-health/SKILL.md, story.5084
 */

import { describe, expect, it } from "vitest";

type Finding = { key: string; level: string };
type Evaluation = { verdict: string; findings: Finding[]; next: string };
const { evaluate } = (await import(
  "../../../scripts/vm-health-snapshot.mjs"
)) as { evaluate: (m: Record<string, number | null>) => Evaluation };

const GiB = 1073741824;
const healthy = {
  memTotalBytes: 16 * GiB,
  memAvailablePct: 65,
  swapUsedBytes: 0,
  swapInPagesPerSec: 0,
  ioWaitPct: 0.1,
  diskUsedPct: 60,
  dbMajorFaultsPerSec: 0.04,
  attributedBytes: 4.8 * GiB,
  usedBytes: 5.6 * GiB,
  probeFailures30m: 0,
  telemetryAgeSec: 20,
};

describe("vm-health evaluate", () => {
  it("grades the post-migration production snapshot GREEN", () => {
    expect(evaluate(healthy).verdict).toBe("GREEN");
  });

  it("grades the pre-migration swap-thrash snapshot RED with memory-pressure advice", () => {
    const r = evaluate({
      ...healthy,
      memTotalBytes: 6.2 * GiB,
      memAvailablePct: 9,
      swapInPagesPerSec: 190,
      ioWaitPct: 45,
      dbMajorFaultsPerSec: 106,
      diskUsedPct: 89,
    });
    expect(r.verdict).toBe("RED");
    expect(r.findings.map((f: Finding) => f.key)).toEqual(
      expect.arrayContaining([
        "swapInPagesPerSec",
        "dbMajorFaultsPerSec",
        "ioWaitPct",
        "memAvailablePct",
      ])
    );
    expect(r.next).toMatch(/Memory pressure/);
  });

  it("treats missing or stale telemetry as RED, never GREEN", () => {
    expect(evaluate({ ...healthy, telemetryAgeSec: null }).verdict).toBe("RED");
    expect(evaluate({ ...healthy, telemetryAgeSec: 900 }).verdict).toBe("RED");
  });

  it("points probe failures without host pressure at the app, not the VM", () => {
    const r = evaluate({ ...healthy, probeFailures30m: 3 });
    expect(r.verdict).toBe("YELLOW");
    expect(r.next).toMatch(/not the VM/);
  });

  it("flags a collector gap when most used memory is unnamed", () => {
    const r = evaluate({
      ...healthy,
      attributedBytes: 1 * GiB,
      usedBytes: 5 * GiB,
    });
    expect(r.findings.some((f: Finding) => f.key === "unattributedPct")).toBe(
      true
    );
  });
});
