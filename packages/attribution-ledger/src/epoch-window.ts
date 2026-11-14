// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/epoch-window`
 * Purpose: Pure, deterministic epoch window computation. Safe in Temporal workflow code (no I/O).
 * Scope: Computes epoch period boundaries from a reference timestamp, aligned to Monday 00:00 UTC. Does not perform I/O or depend on Temporal runtime.
 * Invariants: Deterministic, timezone-anchored, versioned. No I/O or side-effects.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

export interface EpochWindowParams {
  /** ISO timestamp — "as of" reference time */
  readonly asOfIso: string;
  /** Epoch length in days */
  readonly epochLengthDays: number;
  /** IANA timezone for boundary alignment */
  readonly timezone: "UTC"; // V1 only supports UTC; extend later
  /** Which day starts the week */
  readonly weekStart: "monday"; // V1 only supports monday; extend later
}

export interface EpochWindow {
  readonly periodStartIso: string;
  readonly periodEndIso: string;
}

/**
 * Compute epoch window boundaries from a reference timestamp.
 * V1 rule: epochs are aligned to Monday 00:00 UTC boundaries.
 * Floor `asOf` to the most recent Monday, then find which epoch period it falls in.
 *
 * Deterministic, pure, no I/O — safe in Temporal workflow code.
 */
export function computeEpochWindowV1(params: EpochWindowParams): EpochWindow {
  const asOf = new Date(params.asOfIso);
  const msPerDay = 86_400_000;
  const epochMs = params.epochLengthDays * msPerDay;

  // Floor to Monday 00:00 UTC: getUTCDay() returns 0=Sun..6=Sat
  // Shift so Monday=0: (day + 6) % 7
  const dayOfWeek = (asOf.getUTCDay() + 6) % 7; // 0=Mon
  const mondayMs =
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) -
    dayOfWeek * msPerDay;

  // Anchor: first Monday of 2026 (2026-01-05) — stable reference for period indexing
  const anchor = Date.UTC(2026, 0, 5); // 2026-01-05T00:00:00Z (Monday)
  const elapsed = mondayMs - anchor;
  const periodIndex = Math.floor(elapsed / epochMs);
  const periodStartMs = anchor + periodIndex * epochMs;

  return {
    periodStartIso: new Date(periodStartMs).toISOString(),
    periodEndIso: new Date(periodStartMs + epochMs).toISOString(),
  };
}
