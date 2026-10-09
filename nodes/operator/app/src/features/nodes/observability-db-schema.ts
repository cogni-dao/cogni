// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/observability-db-schema`
 * Purpose: Shape the operator's stored migration receipt into the schema readout a node dev reads.
 * Scope: Pure — shapes one stored cell and computes declared-vs-applied drift. Does not do auth, does
 *   not do IO, and does not read a node database.
 * Invariants:
 *   - SILENCE_IS_NOT_SUCCESS: `never_reported` (no cell) and `reported` with an empty applied set are
 *     DIFFERENT states, and the never-reported shape carries nulls — never a `0` or an `[]` that a
 *     dashboard could render as green. Same discipline as the lease log pump's `lease_log_pump_attached`
 *     liveness marker: the absence of lines must be distinguishable from proof of emptiness.
 *   - ENV_FROM_CANONICAL: the env set is the shared `FLIGHT_ENVS`, not a local copy, so adding a deploy
 *     env updates one place and this readout follows.
 *   - DRIFT_IS_THE_GATE: `drift.missing` is non-empty exactly when the image declared a migration the
 *     database does not hold. That is the fail-loud signal a promote gate consumes; this module states
 *     the fact and takes no action on it — the ACTING consumer is the akash-tx migration step, which
 *     shares this module's `hasMissingMigrations` predicate rather than re-deriving it (bug.5415).
 * Side-effects: none
 * Links: shared/migrations/migration-receipt.ts, @ports/node-migration-report.port,
 *   app/api/v1/nodes/[id]/observability/db/schema/route.ts,
 *   features/compute/akash-tx/akash-tx-migration-step.ts
 * @public
 */

import type { FlightEnv, NodeMigrationReportRecord } from "@/ports";
import {
  type AppliedMigration,
  diffDeclaredVsApplied,
  hasMissingMigrations as driftHasMissingMigrations,
  type MigrationDrift,
} from "@/shared/migrations/migration-receipt";
import { FLIGHT_ENVS, isFlightEnv } from "./flight-status";

export { FLIGHT_ENVS, type FlightEnv, isFlightEnv };

/**
 * Liveness of the readout itself, kept separate from its contents.
 *
 * `never_reported` is the honest answer to "we have no idea" — the cell is absent because no
 * migrate has ever reported for this `(node, env)`. It is NOT "zero migrations applied", and it
 * is NOT a failure: a node that has never deployed to an env legitimately sits here.
 */
export type SchemaReadoutState = "never_reported" | "reported";

export interface SchemaReadout {
  readonly nodeId: string;
  readonly slug: string;
  readonly env: FlightEnv;
  /** `never_reported` ⇒ every field below is null. See SILENCE_IS_NOT_SUCCESS. */
  readonly state: SchemaReadoutState;
  /** Human-readable reason, present only for `never_reported`. */
  readonly message?: string;
  readonly declared: readonly string[] | null;
  readonly applied: readonly AppliedMigration[] | null;
  readonly appliedCount: number | null;
  readonly drift: MigrationDrift | null;
  readonly bundleDigest: string | null;
  readonly reporter: string | null;
  readonly reportedAt: string | null;
}

/**
 * The one explanation a dev gets when the operator holds nothing for this cell. Deliberately
 * names the reporter, so "no data" routes to the deploy lane rather than to a support request.
 */
export const NEVER_REPORTED_MESSAGE =
  "no migrate has ever reported applied state for this node in this environment — " +
  "the receipt is emitted by the node's own migrator on a successful deploy, so either this " +
  "node has not deployed here yet or its migrator image predates receipt reporting";

/** Shape a stored cell (or its absence) into the readout. */
export function shapeSchemaReadout(input: {
  readonly nodeId: string;
  readonly slug: string;
  readonly env: FlightEnv;
  readonly record: NodeMigrationReportRecord | null;
}): SchemaReadout {
  const base = { nodeId: input.nodeId, slug: input.slug, env: input.env };
  if (!input.record) {
    return {
      ...base,
      state: "never_reported",
      message: NEVER_REPORTED_MESSAGE,
      declared: null,
      applied: null,
      appliedCount: null,
      drift: null,
      bundleDigest: null,
      reporter: null,
      reportedAt: null,
    };
  }
  const { declared, applied } = input.record;
  return {
    ...base,
    state: "reported",
    declared,
    applied,
    // Recomputed rather than read back: the denormalized column is a gate convenience, and the
    // array it summarizes is the fact. They cannot disagree in the response.
    appliedCount: applied.length,
    drift: diffDeclaredVsApplied({ declared, applied }),
    bundleDigest: input.record.bundleDigest,
    reporter: input.record.reporter,
    reportedAt: input.record.reportedAt,
  };
}

/**
 * The gate predicate at READOUT altitude. A readout fails the gate when it REPORTED missing
 * migrations; `never_reported` carries a null drift and is explicitly NOT a failure — an unknown
 * must not be laundered into a verdict.
 *
 * Delegates to the shared drift-level predicate rather than re-deriving the comparison, so this
 * badge and the akash-tx migration step that actually BLOCKS on it (`runMigrationStep`) can never
 * disagree about what "missing" means.
 */
export function hasMissingMigrations(readout: SchemaReadout): boolean {
  return driftHasMissingMigrations(readout.drift);
}
