// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/vcs/flight-slot-gate`
 * Purpose: Pure decision logic for the candidate-a flight slot fast-reject — is the
 *   single candidate slot already leased by a still-live flight? No IO; the route
 *   composes this with the read-only lease it fetched via DeployPlanePort.
 * Scope: One total function over a parsed `CandidateLease | null` + a clock reading.
 *   Unit-testable without a container or GitHub.
 * Invariants:
 *   - WORKFLOW_IS_LEASE_AUTHORITY: this gate is fast-fail UX, exactly like
 *     `merge-gate.ts` sits in front of GitHub branch protection. The
 *     candidate-slot-controller GitHub Actions workflow remains the SOLE
 *     writer/acquirer of the lease; this only READS a lease it already wrote and
 *     rejects early so a concurrent flight fast-fails (409) instead of dispatching
 *     into an eviction (bug.5249). It never writes a competing lease.
 *   - EXPIRED_IS_NOT_BUSY: a lease whose `expiresAt` is in the past is NOT busy —
 *     the workflow TTL-reclaims a stale lease on the next acquire, so a lease left
 *     behind by a crashed/abandoned run must never wedge the slot. Only a `leased`
 *     state WITH a future expiry is a live lease.
 *   - FAIL_OPEN_ON_UNKNOWN: an absent lease (`null`), a `free`/`failed` state, or a
 *     `leased` lease with a missing/unparseable `expiresAt` all ALLOW — a malformed
 *     or missing lease must never block a flight; the workflow's own acquire is the
 *     real gate (TOCTOU: best-effort only).
 * Side-effects: none (pure)
 * Links: nodes/operator/app/src/app/api/v1/vcs/flight/route.ts,
 *   nodes/operator/app/src/features/vcs/merge-gate.ts, story.5042, bug.5249
 * @public
 */

import type { CandidateLease } from "@/ports";

/** A flight refusal: the HTTP status to return, a stable code, and a human message. */
export interface FlightSlotRejection {
  readonly status: number;
  readonly errorCode: string;
  readonly error: string;
}

/**
 * Fast-reject gate over the candidate-a slot lease. Returns `null` when the flight
 * may proceed, or a `409 slot_busy` rejection when the slot is actively leased by a
 * still-live run.
 *
 * @param lease  the parsed lease read from the deploy branch, or `null` when the
 *   lease file is absent (never provisioned, or purged) — treated as free.
 * @param nowMs  the current wall-clock reading in epoch milliseconds (`Date.now()`),
 *   injected so the TTL comparison stays pure and unit-testable.
 */
export function evaluateFlightSlotGate(
  lease: CandidateLease | null,
  nowMs: number
): FlightSlotRejection | null {
  // Absent lease → the slot was never leased (or the file is gone). Allow.
  if (!lease) return null;

  // Released states (`free`/`failed`) are not busy. Allow.
  if (lease.state !== "leased") return null;

  // TTL/clock reasoning: a `leased` lease only blocks while it is still LIVE. The
  // workflow stamps `expiresAt` when it acquires and TTL-reclaims any lease past that
  // deadline on its next acquire, so an expired lease is a corpse — not a live holder
  // — and must NOT block a new flight (otherwise a crashed run wedges the slot until a
  // human intervenes). A missing/unparseable `expiresAt` is treated the same way: we
  // cannot prove the lease is live, so we fail OPEN rather than block on a malformed
  // lease. Only a `leased` state with a parseable, still-in-the-future `expiresAt`
  // is a live lease that should reject a concurrent flight.
  const expiresAtMs = lease.expiresAt
    ? Date.parse(lease.expiresAt)
    : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return null;
  if (expiresAtMs <= nowMs) return null;

  const owner =
    lease.prNumber !== undefined ? `PR #${lease.prNumber}` : "another flight";
  const run = lease.runId !== undefined ? ` (run ${lease.runId})` : "";
  return {
    status: 409,
    errorCode: "slot_busy",
    error: `candidate-a slot is leased by ${owner}${run} until ${lease.expiresAt}`,
  };
}
