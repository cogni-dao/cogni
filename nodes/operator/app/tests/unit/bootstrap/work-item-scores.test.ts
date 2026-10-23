// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-scores`
 * Purpose: Pin the operator's ONE `scores` evidence-host allow-list (story.5111).
 * Scope: Pure function + the package validator it feeds. Does not touch the adapter or HTTP.
 * Invariants:
 *   - EXACT_HOSTS_ONLY: package default plus the exact `GRAFANA_URL` host; never `*.grafana.net`.
 * Side-effects: none
 * Links: src/bootstrap/work-item-scores.ts, packages/work-items/src/scores.ts (node-template)
 * @internal
 */

import {
  DEFAULT_SCORE_EVIDENCE_HOSTS,
  parseWorkItemScores,
} from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import { workItemScoreEvidenceHosts } from "@/bootstrap/work-item-scores";

const ev = (url: string) => ({ goal: { v: 5, ev: url } });

describe("workItemScoreEvidenceHosts (story.5111)", () => {
  it("is the package default when GRAFANA_URL is unset", () => {
    expect(workItemScoreEvidenceHosts(undefined)).toEqual([
      ...DEFAULT_SCORE_EVIDENCE_HOSTS,
    ]);
  });

  it("adds the exact GRAFANA_URL host, never a shared-tenant wildcard", () => {
    const hosts = workItemScoreEvidenceHosts("https://Cogni-Ops.grafana.net/");
    expect(hosts).toEqual([
      ...DEFAULT_SCORE_EVIDENCE_HOSTS,
      "cogni-ops.grafana.net",
    ]);
    expect(hosts).not.toContain("*.grafana.net");
    expect(Object.isFrozen(hosts)).toBe(true);
  });

  it("lets the validator accept the operator stack and reject another tenant", () => {
    const evidenceHosts = workItemScoreEvidenceHosts(
      "https://cogni-ops.grafana.net"
    );
    expect(
      parseWorkItemScores(ev("https://cogni-ops.grafana.net/d/abc"), {
        evidenceHosts,
      }).ok
    ).toBe(true);
    const other = parseWorkItemScores(ev("https://attacker.grafana.net/d/x"), {
      evidenceHosts,
    });
    expect(other.ok).toBe(false);
    expect(!other.ok && other.issues[0]?.code).toBe(
      "evidence_host_not_allowed"
    );
    expect(
      parseWorkItemScores(ev("https://cognidao.org/work/items/story.5111"), {
        evidenceHosts,
      }).ok
    ).toBe(true);
  });
});
