// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/attribution/epoch-views.activity`
 * Purpose: Regression for bug.5647 — `buildEpochActivityView` returned 500
 *   (`ReferenceError: Cannot access 'd' before initialization`) whenever read-time identity
 *   resolution resolved at least one GitHub identity, because its `onResolved` callback read
 *   `receipts`/`selectionMap` (const-destructured from the very `loadEnrichedReceipts` call
 *   that invokes the callback) while they were still in the temporal dead zone.
 * Scope: Unit test over a fake `AttributionStore`. Does not test HTTP routes or the database.
 * Invariants: IDENTITY_RESOLVED_AT_READ_PERSISTS — resolved userIds are persisted to null-userId
 *   selections and reported once via `onIdentityResolved`.
 * Side-effects: none
 * Links: src/features/attribution/read/epoch-views.ts
 * @internal
 */

import type { AttributionStore } from "@cogni/attribution-ledger";
import { describe, expect, it, vi } from "vitest";
import {
  buildEpochActivityView,
  buildEpochContributorsView,
  EPOCH_NOT_FOUND,
} from "@/features/attribution/read/epoch-views";

const EPOCH_ID = 7n;
const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";

function receipt(receiptId: string, platformUserId: string) {
  return {
    receiptId,
    source: "github",
    eventType: "pr_merged",
    platformUserId,
    platformLogin: `login-${platformUserId}`,
    artifactUrl: `https://github.com/o/r/pull/${receiptId}`,
    metadata: {},
    eventTime: new Date("2026-11-10T00:00:00.000Z"),
  };
}

function selection(receiptId: string, userId: string | null) {
  return {
    receiptId,
    userId,
    included: true,
    weightOverrideMilli: null,
    note: null,
  };
}

function makeStore(opts: { resolved: Map<string, string> }) {
  const updateSelectionUserId = vi.fn(async () => {});
  const store = {
    getEpoch: vi.fn(async () => ({
      id: EPOCH_ID,
      status: "open",
      periodStart: new Date("2026-11-03T00:00:00.000Z"),
      periodEnd: new Date("2026-11-10T00:00:00.000Z"),
      weightConfig: { "github:pr_merged": 8000 },
      poolTotalCredits: null,
    })),
    getReceiptsForWindow: vi.fn(async () => [receipt("r1", "u1")]),
    getReceiptsForEpoch: vi.fn(async () => [receipt("r2", "u2")]),
    getSelectionForEpoch: vi.fn(async () => [
      selection("r1", null),
      selection("r2", null),
    ]),
    resolveIdentities: vi.fn(async () => opts.resolved),
    updateSelectionUserId,
  } as unknown as AttributionStore;
  return { store, updateSelectionUserId };
}

describe("buildEpochActivityView — read-time identity resolution (bug.5647)", () => {
  it("returns the view (no TDZ ReferenceError) when identities resolve at read time", async () => {
    const { store, updateSelectionUserId } = makeStore({
      resolved: new Map([["u1", "user-1"]]),
    });
    const onIdentityResolved = vi.fn();

    const view = await buildEpochActivityView(
      store,
      NODE_ID,
      EPOCH_ID,
      "7",
      { limit: 50, offset: 0 },
      onIdentityResolved
    );

    expect(view).not.toBe(EPOCH_NOT_FOUND);
    if (view === EPOCH_NOT_FOUND) return;
    expect(view.total).toBe(2);
    expect(
      view.events.find((e) => e.receiptId === "r1")?.selection?.userId
    ).toBe("user-1");

    // Persists only the receipt whose identity resolved, and reports counts once.
    expect(updateSelectionUserId).toHaveBeenCalledTimes(1);
    expect(updateSelectionUserId).toHaveBeenCalledWith(
      EPOCH_ID,
      "r1",
      "user-1"
    );
    expect(onIdentityResolved).toHaveBeenCalledTimes(1);
    expect(onIdentityResolved).toHaveBeenCalledWith({
      resolvedCount: 1,
      unresolvedCount: 1,
    });
  });

  it("does not persist or report when nothing resolves", async () => {
    const { store, updateSelectionUserId } = makeStore({ resolved: new Map() });
    const onIdentityResolved = vi.fn();

    const view = await buildEpochActivityView(
      store,
      NODE_ID,
      EPOCH_ID,
      "7",
      { limit: 50, offset: 0 },
      onIdentityResolved
    );

    expect(view).not.toBe(EPOCH_NOT_FOUND);
    expect(updateSelectionUserId).not.toHaveBeenCalled();
    expect(onIdentityResolved).not.toHaveBeenCalled();
  });

  it("contributors view (read-only resolution) does not persist", async () => {
    const { store, updateSelectionUserId } = makeStore({
      resolved: new Map([["u1", "user-1"]]),
    });
    const view = await buildEpochContributorsView(store, NODE_ID, EPOCH_ID);
    expect(view).not.toBe(EPOCH_NOT_FOUND);
    expect(updateSelectionUserId).not.toHaveBeenCalled();
  });
});
