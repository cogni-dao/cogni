// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/fleet-observation-reader.adapter`
 * Purpose: Read-only SQL over the `@cogni-dao/metrics` observation store (`metric_observations`) for the
 *   stored `fleet.lanes-down@1` readings that `fleet.uptime@1` integrates (task.5457).
 * Scope: IO only. The package owns the table, its writer and its scope key `<node>/<environment>/<dataScope>`;
 *   this adapter reads rows in this operator's own `<node>/<environment>/` scopes and never writes one.
 * Invariants:
 *   - READ_ONLY: SELECT only; never writes, refreshes or backfills an observation.
 *   - OWN_SCOPE_ONLY: rows are filtered by the scope prefix `<node>/<environment>/`, so one environment never
 *     reads another's readings.
 *   - OK_ONLY: only `status = 'ok'` rows reach the caller; error/unavailable/pending are gaps.
 *   - BOUNDED: `LIMIT maxRows + 1` (the extra row reports `truncated`); cancelled when the signal aborts.
 *   - IDENTITY_FROM_STORED_DEFINITION: a reading is a lanes-down reading for `env` when its stored calculator
 *     version is `fleet.lanes-down@1` and its stored definition params are `{env, output: "down"}`.
 * Side-effects: IO (Postgres reads)
 * Links: ports/fleet-observation.port.ts, features/node-deploy/fleet-kpis.ts, task.5457
 * @internal
 */

import type { Sql } from "postgres";
import type { FleetObservationReaderPort } from "@/ports";
import { cancellable } from "./delivery-kpi-source.adapter";

/** The calculator id whose readings are read; kept literal so the adapter needs no feature import. */
const LANES_DOWN_CALCULATOR = "fleet.lanes-down@1";

export class FleetObservationReader implements FleetObservationReaderPort {
  /**
   * @param scopePrefix the package scope key up to the data scope: `<node>/<environment>/`.
   */
  constructor(
    private readonly sql: Sql,
    private readonly scopePrefix: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async lanesDown(input: {
    readonly env: string;
    readonly from: Date;
    readonly to: Date;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }) {
    const s = this.sql;
    const rows = await cancellable(
      s`
        SELECT o.id, o.evaluation_at, ev.ref AS evidence
        FROM metric_observations o
        CROSS JOIN LATERAL (
          SELECT e.ref
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(o.observation -> 'evidenceRefs') = 'array'
              THEN o.observation -> 'evidenceRefs' ELSE '[]'::jsonb END
          ) AS e(ref)
          WHERE e.ref LIKE 'fleet:declared=%'
          LIMIT 1
        ) ev
        WHERE starts_with(o.scope, ${this.scopePrefix})
          AND o.status = 'ok'
          AND o.observation ->> 'calculatorVersion' = ${LANES_DOWN_CALCULATOR}
          AND o.snapshot -> 'spec' -> 'params' ->> 'env' = ${input.env}
          AND o.snapshot -> 'spec' -> 'params' ->> 'output' = 'down'
          AND o.evaluation_at >= ${input.from.toISOString()}::timestamptz
          AND o.evaluation_at < ${input.to.toISOString()}::timestamptz
        ORDER BY o.evaluation_at, o.id
        LIMIT ${input.maxRows + 1}
      `,
      input.signal
    );
    return {
      rows: rows.slice(0, input.maxRows).map((r) => ({
        observationId: String(r.id),
        at: new Date(r.evaluation_at as string | Date),
        evidence: String(r.evidence),
      })),
      truncated: rows.length > input.maxRows,
      asOf: this.clock(),
    };
  }
}
