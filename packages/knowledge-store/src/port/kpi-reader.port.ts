// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/port/kpi-reader`
 * Purpose: KpiReader port — maps a `metric:<kpi-id>` goal's KPI id to a current 0–100 reading; the goal-loop controller reads the KPI through this port each tick, and `loopHaltReason` consumes the number opaquely.
 * Scope: Port interface + registry types only. Does not contain implementations or I/O.
 * Invariants:
 *   - KPI_VERIFIER_INDEPENDENT — a reader MUST be independent of the loop's own
 *     writes. The worker (storage-expert role) files `evidence_for` atoms; the
 *     KpiReader (a separate read — external count, held-out check, or judge role)
 *     scores the KPI. A reader that returns `confidence_pct` of the row the loop
 *     writes to is a SMOKE TEST only — never a real goal's KPI.
 *   - KPI_RANGE_0_100 — `read` returns 0–100, same scale as `target`/`confidence_pct`.
 * Side-effects: none (implementations do I/O; the port does not)
 * Links: docs/spec/knowledge-syntropy.md, docs/design/knowledge-goal-loop.md
 * @public
 */

import type { Goal } from "../domain/goal-loop.js";

/**
 * Reads the current value of a single KPI for a goal. The `goal` is passed so a
 * reader can scope its read (domain, kpi id, target denominator) without a
 * second DB round-trip. MUST be verifier-independent (see KPI_VERIFIER_INDEPENDENT).
 */
export interface KpiReader {
  /** Stable id this reader serves (matches the `metric:<kpiId>` binding). */
  readonly kpiId: string;
  /**
   * Is this reader independent of the loop's own writes? `true` for a real
   * goal; `false` only for the fenced `confidence-smoke` reader. The registry
   * + controller use this to refuse to gate a real goal on a self-grading reader.
   */
  readonly independent: boolean;
  /** Current KPI reading, clamped 0–100. */
  read(goal: Goal): Promise<number>;
}

/**
 * Resolves a `kpiId` to its reader. Plug-n-play per goal: a goal binds to a KPI
 * by id (`metric:<kpiId>`); the registry hands the controller the matching
 * reader, or `null` if the id is unregistered (the controller halts that goal
 * rather than guessing a metric).
 */
export interface KpiReaderRegistry {
  get(kpiId: string): KpiReader | null;
  /**
   * Read the KPI for a goal, or `null` if no reader is registered for its id.
   *
   * REFUSES a non-independent (smoke) reader for a real goal — per
   * KPI_VERIFIER_INDEPENDENT, a real goal must never be gated on a self-grading
   * reader. Pass `{ allowSmoke: true }` ONLY from smoke tests to read a fenced
   * `independent: false` reader; without it, a non-independent reader throws.
   */
  read(goal: Goal, opts?: { allowSmoke?: boolean }): Promise<number | null>;
}

/** Thrown when a real goal is read through a non-independent (smoke) reader. */
export class NonIndependentKpiReaderError extends Error {
  constructor(public readonly kpiId: string) {
    super(
      `KpiReader '${kpiId}' is not verifier-independent (smoke-test only); ` +
        "refusing to gate a real goal on a self-grading reader " +
        "(KPI_VERIFIER_INDEPENDENT). Pass { allowSmoke: true } only from smoke tests."
    );
    this.name = "NonIndependentKpiReaderError";
  }
}
