// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/fleet-observation`
 * Purpose: The read-only view of stored `fleet.lanes-down@1` readings that `fleet.uptime@1` integrates
 *   (task.5457, story.5146). The calculator probes nothing: uptime is the stored lane-probe counts.
 * Scope: Interface only. The Postgres adapter lives in `adapters/server/node-deploy/`; the calculator
 *   lives in `features/node-deploy/fleet-kpis.ts`.
 * Invariants:
 *   - READ_ONLY: stored readings are immutable facts; this port never writes, refreshes or backfills one.
 *   - OK_ONLY: only readings with status `ok` are returned. A gap stays a gap; it is never filled.
 *   - BOUNDED: the read takes `maxRows` and reports `truncated` instead of dropping rows.
 * Side-effects: none
 * Links: features/node-deploy/fleet-kpis.ts, task.5457
 * @public
 */

/** One stored `ok` reading of `fleet.lanes-down@1 {env, output: "down"}`. */
export interface FleetLanesDownReading {
  /** The observation id, for evidence. */
  readonly observationId: string;
  /** The evaluation instant of the reading (end of its window). */
  readonly at: Date;
  /** The reading's `fleet:declared=…,probed=…,down=…` evidence line, parsed by the calculator. */
  readonly evidence: string;
}

export interface FleetObservationReaderPort {
  /** Readings of the lanes-down metric for `env` evaluated in `[from, to)`, oldest first. */
  lanesDown(input: {
    readonly env: string;
    readonly from: Date;
    readonly to: Date;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly rows: readonly FleetLanesDownReading[];
    readonly truncated: boolean;
    readonly asOf: Date;
  }>;
}
