// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/compose-epoch`
 * Purpose: Verifies epoch view composition and client-side override application.
 * Scope: Unit tests for current-epoch UI composition only. Does not test HTTP routes or database queries.
 * Invariants:
 * - UNLINKED_VISIBLE_IN_CURRENT_EPOCH: unresolved contributors render as normal rows
 * - NO_GUID_DISPLAY: contributor names must not fall back to raw user ID prefixes
 * - OVERRIDE_MILLI_CONVERSION: applyOverridesToEpochView converts display-scale units (* 1000) to milli
 * Side-effects: none
 * Links: src/features/governance/lib/compose-epoch.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  applyOverridesToEpochView,
  composeEpochView,
  type OverrideEntry,
} from "@/features/governance/lib/compose-epoch";
import type { EpochView } from "@/features/governance/types";

describe("composeEpochView", () => {
  it("includes unresolved contributors as normal rows and uses platform logins", () => {
    const view = composeEpochView(
      {
        id: "12",
        status: "open",
        periodStart: "2026-03-02T00:00:00.000Z",
        periodEnd: "2026-03-09T00:00:00.000Z",
        weightConfig: {
          "github:pr_merged": 8000,
          "github:review_submitted": 2000,
        },
        poolTotalCredits: null,
      },
      [
        {
          userId: "d0000000-0000-4000-a000-000058641509",
          projectedUnits: "8000",
          receiptCount: 1,
        },
      ],
      [
        {
          receiptId: "r1",
          source: "github",
          eventType: "pr_merged",
          platformUserId: "58641509",
          platformLogin: "derekg1729",
          artifactUrl: null,
          eventTime: "2026-03-03T00:00:00.000Z",
          selection: {
            userId: "d0000000-0000-4000-a000-000058641509",
            included: true,
            weightOverrideMilli: null,
          },
        },
        {
          receiptId: "r2",
          source: "github",
          eventType: "review_submitted",
          platformUserId: "90000103",
          platformLogin: "mira-stone",
          artifactUrl: null,
          eventTime: "2026-03-04T00:00:00.000Z",
          selection: {
            userId: null,
            included: true,
            weightOverrideMilli: null,
          },
        },
      ]
    );

    expect(view.contributors).toHaveLength(2);
    expect(
      view.contributors.map((contributor) => contributor.displayName)
    ).toEqual(["derekg1729", "mira-stone"]);
    expect(
      view.contributors.map((contributor) => contributor.claimantKind)
    ).toEqual(["user", "identity"]);
    expect(
      view.contributors.some((contributor) =>
        contributor.displayName?.includes("d0000000")
      )
    ).toBe(false);
  });

  it("excludes receipts with null selection from contributor aggregation", () => {
    const view = composeEpochView(
      {
        id: "13",
        status: "open",
        periodStart: "2026-03-09T00:00:00.000Z",
        periodEnd: "2026-03-16T00:00:00.000Z",
        weightConfig: {
          "github:pr_merged": 8000,
        },
        poolTotalCredits: null,
      },
      [],
      [
        {
          receiptId: "r-included",
          source: "github",
          eventType: "pr_merged",
          platformUserId: "58641509",
          platformLogin: "derekg1729",
          artifactUrl: null,
          eventTime: "2026-03-10T00:00:00.000Z",
          metadata: null,
          selection: {
            userId: null,
            included: true,
            weightOverrideMilli: null,
          },
        },
        {
          receiptId: "r-null-selection",
          source: "github",
          eventType: "pr_merged",
          platformUserId: "99999999",
          platformLogin: "Cogni-1729",
          artifactUrl: null,
          eventTime: "2026-03-11T00:00:00.000Z",
          metadata: null,
          selection: null,
        },
      ]
    );

    // Only 1 contributor — the null-selection receipt should be excluded
    expect(view.contributors).toHaveLength(1);
    expect(view.contributors[0].displayName).toBe("derekg1729");
    // Unresolved count should only include the included receipt (no userId)
    expect(view.unresolvedCount).toBe(1);
  });
});

/* ---------------------------------------------------------------------------
 * applyOverridesToEpochView — client-side override recomputation
 * --------------------------------------------------------------------------- */

/** Helper: build a minimal EpochView for override tests. */
function makeEpochView(
  contributors: {
    claimantKey: string;
    receipts: { receiptId: string; units: string }[];
  }[]
): EpochView {
  // Compute totals so creditShare is realistic
  const totalUnits = contributors.reduce(
    (sum, c) =>
      sum + c.receipts.reduce((rSum, r) => rSum + BigInt(r.units ?? "0"), 0n),
    0n
  );

  return {
    id: "1",
    status: "review",
    periodStart: "2026-03-01T00:00:00.000Z",
    periodEnd: "2026-03-08T00:00:00.000Z",
    poolTotalCredits: "10000",
    unresolvedCount: 0,
    unresolvedActivities: [],
    contributors: contributors.map((c) => {
      const units = c.receipts
        .reduce((s, r) => s + BigInt(r.units ?? "0"), 0n)
        .toString();
      const share =
        totalUnits > 0n
          ? Math.round((Number(BigInt(units)) / Number(totalUnits)) * 1000) / 10
          : 0;
      return {
        claimantKey: c.claimantKey,
        claimantKind: "user" as const,
        isLinked: true,
        displayName: c.claimantKey,
        claimantLabel: "Linked account",
        avatar: "👤",
        color: "220 15% 50%",
        units,
        creditShare: share,
        receiptCount: c.receipts.length,
        receipts: c.receipts.map((r) => ({
          receiptId: r.receiptId,
          source: "github",
          eventType: "pr_merged",
          platformLogin: null,
          artifactUrl: null,
          eventTime: "2026-03-03T00:00:00.000Z",
          units: r.units,
          metadata: null,
        })),
      };
    }),
  };
}

describe("applyOverridesToEpochView", () => {
  it("returns identical epoch when overrides map is empty", () => {
    const epoch = makeEpochView([
      { claimantKey: "alice", receipts: [{ receiptId: "r1", units: "8000" }] },
    ]);
    const result = applyOverridesToEpochView(epoch, new Map());
    expect(result).toBe(epoch); // same reference — early return
  });

  it("applies override units directly — same scale as receipt units", () => {
    const epoch = makeEpochView([
      { claimantKey: "alice", receipts: [{ receiptId: "r1", units: "8000" }] },
    ]);
    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: "2000" }],
    ]);
    const result = applyOverridesToEpochView(epoch, overrides);

    expect(result.contributors[0].units).toBe("2000");
    // Receipt units are never mutated — UI reads original for strikethrough display
    expect(result.contributors[0].receipts[0].units).toBe("8000");
  });

  it("applies partial overrides — only overridden receipts change", () => {
    const epoch = makeEpochView([
      {
        claimantKey: "alice",
        receipts: [
          { receiptId: "r1", units: "8000" },
          { receiptId: "r2", units: "2000" },
        ],
      },
    ]);
    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: "3000" }],
    ]);
    const result = applyOverridesToEpochView(epoch, overrides);

    // r1: 3000 (overridden), r2: unchanged 2000, total = 5000
    expect(result.contributors[0].units).toBe("5000");
    // Receipts preserve original units — never mutated by overrides
    expect(result.contributors[0].receipts[0].units).toBe("8000");
    expect(result.contributors[0].receipts[1].units).toBe("2000");
  });

  it("recalculates share percentages across all contributors", () => {
    const epoch = makeEpochView([
      { claimantKey: "alice", receipts: [{ receiptId: "r1", units: "8000" }] },
      { claimantKey: "bob", receipts: [{ receiptId: "r2", units: "2000" }] },
    ]);
    // Before: alice=80%, bob=20%

    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: "2000" }],
    ]);
    const result = applyOverridesToEpochView(epoch, overrides);

    // After: alice=2000, bob=2000 → 50/50
    expect(result.contributors[0].creditShare).toBe(50);
    expect(result.contributors[1].creditShare).toBe(50);
  });

  it("re-sorts contributors when override changes relative ranking", () => {
    const epoch = makeEpochView([
      { claimantKey: "alice", receipts: [{ receiptId: "r1", units: "8000" }] },
      { claimantKey: "bob", receipts: [{ receiptId: "r2", units: "2000" }] },
    ]);
    // Before: alice first (8000 > 2000)
    expect(epoch.contributors[0].claimantKey).toBe("alice");

    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: "1000" }], // 1000 < 2000
    ]);
    const result = applyOverridesToEpochView(epoch, overrides);

    // After: bob first (2000 > 1000)
    expect(result.contributors[0].claimantKey).toBe("bob");
    expect(result.contributors[1].claimantKey).toBe("alice");
  });

  it("handles null receipt units — override counted, null treated as 0", () => {
    const epoch: EpochView = {
      ...makeEpochView([
        {
          claimantKey: "alice",
          receipts: [{ receiptId: "r1", units: "0" }],
        },
      ]),
    };
    // Manually set units to null to simulate finalized epoch receipts
    const withNullUnits: EpochView = {
      ...epoch,
      contributors: epoch.contributors.map((c) => ({
        ...c,
        receipts: c.receipts.map((r) => ({ ...r, units: null })),
      })),
    };

    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: "5000" }],
    ]);
    const result = applyOverridesToEpochView(withNullUnits, overrides);

    expect(result.contributors[0].units).toBe("5000");
  });

  it("ignores overrides with null overrideUnits — keeps original receipt weight", () => {
    const epoch = makeEpochView([
      { claimantKey: "alice", receipts: [{ receiptId: "r1", units: "8000" }] },
    ]);
    const overrides = new Map<string, OverrideEntry>([
      ["r1", { subjectRef: "r1", overrideUnits: null }],
    ]);
    const result = applyOverridesToEpochView(epoch, overrides);

    expect(result.contributors[0].units).toBe("8000");
  });
});
