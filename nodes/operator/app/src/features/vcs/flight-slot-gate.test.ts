// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import type { CandidateLease } from "@/ports";
import { evaluateFlightSlotGate } from "./flight-slot-gate";

/** Fixed clock so the TTL comparison is deterministic. */
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const FUTURE = new Date(NOW_MS + 10 * 60_000).toISOString();
const PAST = new Date(NOW_MS - 10 * 60_000).toISOString();

/** A live lease held by a still-running flight — the only input that rejects. */
function leased(overrides: Partial<CandidateLease> = {}): CandidateLease {
  return {
    slot: "candidate-a",
    state: "leased",
    prNumber: 2415,
    runId: "1234567890",
    headSha: "a".repeat(40),
    acquiredAt: new Date(NOW_MS - 60_000).toISOString(),
    expiresAt: FUTURE,
    statusUrl: "https://github.com/Cogni-DAO/cogni/actions/runs/1234567890",
    ...overrides,
  };
}

describe("evaluateFlightSlotGate", () => {
  it("rejects (409 slot_busy) a lease still live (future expiry)", () => {
    const r = evaluateFlightSlotGate(leased(), NOW_MS);
    expect(r).toEqual(
      expect.objectContaining({ status: 409, errorCode: "slot_busy" })
    );
    expect(r?.error).toContain("PR #2415");
    expect(r?.error).toContain("1234567890");
  });

  it("allows a leased slot whose expiry is in the past (TTL-reclaimable)", () => {
    expect(
      evaluateFlightSlotGate(leased({ expiresAt: PAST }), NOW_MS)
    ).toBeNull();
  });

  it("allows a leased slot at the exact expiry boundary (not strictly future)", () => {
    expect(
      evaluateFlightSlotGate(
        leased({ expiresAt: new Date(NOW_MS).toISOString() }),
        NOW_MS
      )
    ).toBeNull();
  });

  it("allows a leased slot with a missing expiry (fail open on malformed lease)", () => {
    expect(
      evaluateFlightSlotGate(
        { slot: "candidate-a", state: "leased", prNumber: 1 },
        NOW_MS
      )
    ).toBeNull();
  });

  it("allows a leased slot with an unparseable expiry (fail open)", () => {
    expect(
      evaluateFlightSlotGate(leased({ expiresAt: "not-a-date" }), NOW_MS)
    ).toBeNull();
  });

  it("allows a released (free) slot", () => {
    expect(
      evaluateFlightSlotGate({ slot: "candidate-a", state: "free" }, NOW_MS)
    ).toBeNull();
  });

  it("allows a released (failed) slot", () => {
    expect(
      evaluateFlightSlotGate({ slot: "candidate-a", state: "failed" }, NOW_MS)
    ).toBeNull();
  });

  it("allows when the lease file is absent (null sentinel)", () => {
    expect(evaluateFlightSlotGate(null, NOW_MS)).toBeNull();
  });

  it("still rejects a live lease that is missing pr/run metadata", () => {
    const r = evaluateFlightSlotGate(
      { slot: "candidate-a", state: "leased", expiresAt: FUTURE },
      NOW_MS
    );
    expect(r).toEqual(
      expect.objectContaining({ status: 409, errorCode: "slot_busy" })
    );
    expect(r?.error).toContain("another flight");
  });
});
