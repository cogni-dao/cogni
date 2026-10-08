// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/build-client`
 * Purpose: Factory for creating a postgres.js client configured for Doltgres, plus the safe session-pinned-connection acquirer every Dolt branch op must use.
 * Scope: Connection factory + `reserveDoltgresConnection`. Does not load env vars or manage lifecycle.
 * Invariants:
 *   - Connection string injected, never from process.env (PACKAGES_NO_ENV).
 *   - `fetch_types: false` is mandatory for Doltgres and is what makes
 *     `PRIME_BEFORE_RESERVE` load-bearing — see `reserveDoltgresConnection`.
 *   - Nothing in this package may call `sql.reserve()` directly; it must go
 *     through `reserveDoltgresConnection` so a cold pool cannot hang forever.
 * Side-effects: IO (database connections)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import postgres, { type ReservedSql, type Sql } from "postgres";

export interface DoltgresClientConfig {
  /** Postgres-format connection string pointing at a Doltgres database */
  connectionString: string;
  /** Application name for connection logging */
  applicationName?: string;
  /** Max pool size (default: 5 — knowledge store is low-frequency) */
  max?: number;
}

/**
 * Create a postgres.js client configured for Doltgres compatibility.
 *
 * Key differences from standard Postgres client:
 * - fetch_types: false — Doltgres pg_type table requires explicit grants
 * - Lower pool size — knowledge plane is low-frequency (hours-to-days tempo)
 */
export function buildDoltgresClient(config: DoltgresClientConfig) {
  return postgres(config.connectionString, {
    max: config.max ?? 5,
    idle_timeout: 30,
    connect_timeout: 10,
    fetch_types: false,
    connection: {
      application_name: config.applicationName ?? "cogni_knowledge_store",
    },
  });
}

/**
 * Hard ceiling on how long `reserveDoltgresConnection` will wait for a
 * session-pinned connection. Chosen above `connect_timeout` (10s) so a genuine
 * TCP/handshake failure surfaces as itself, while a wedged pool still FAILS
 * rather than hanging for the lifetime of the process (bug.5386).
 */
export const DOLTGRES_RESERVE_TIMEOUT_MS = 15_000;

/** Thrown when a session-pinned Doltgres connection cannot be acquired. */
export class DoltgresReserveTimeoutError extends Error {
  readonly code = "DOLTGRES_RESERVE_TIMEOUT" as const;

  constructor(timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms acquiring a session-pinned Doltgres connection. ` +
        "The knowledge-store connection pool is exhausted or wedged."
    );
    this.name = "DoltgresReserveTimeoutError";
  }
}

/**
 * Acquire a session-pinned (`reserve()`d) connection for Dolt branch work.
 *
 * PRIME_BEFORE_RESERVE — why this wrapper exists instead of a bare
 * `sql.reserve()` (bug.5386):
 *
 * postgres.js v3.4.7 never resolves a `reserve()` that lands on a connection
 * which has not yet completed a query, when the client is built with
 * `fetch_types: false` (which Doltgres requires — its `pg_type` needs grants
 * we do not hold). Mechanism, in `node_modules/postgres/src`:
 *
 *   1. `index.js` `reserve()` — with an empty `open` queue it pushes a
 *      `{ reserve, reject }` pseudo-query and cold-connects a `closed` slot.
 *   2. `connection.js` `ReadyForQuery()` — for that pseudo-query `needsTypes`
 *      is false (because `fetch_types: false`), so the `fetchArrayTypes()`
 *      branch that would later re-enter `ReadyForQuery` and call
 *      `onopen(connection)` is skipped, and `execute(initial)` is skipped too
 *      because `initial.reserve` is truthy. `initial` is nulled and the
 *      function returns WITHOUT calling `onopen`.
 *   3. `onopen` is the only thing that invokes `query.reserve(c)`, so the
 *      awaited promise never settles. `connect_timeout` was already cancelled
 *      by `ReadyForQuery`, so nothing rescues it.
 *
 * The connection is also left in the `connecting` queue permanently, so each
 * cold-reserve burns one pool slot. At `max: 5` the sixth request finds every
 * queue empty and `handler()` parks ordinary reads on `queries` forever: the
 * whole knowledge plane wedges, reads included, with no error logged anywhere.
 * That is exactly the candidate-a signature in bug.5386 — "request received",
 * zero completions, zero errors.
 *
 * Any ordinary query takes the normal `handler()` path, which DOES reach
 * `onopen` and leaves the connection in `open`, so the defect is invisible
 * whenever some read precedes the reserve. The open-contribution quota's
 * `list({state:"open"})` SELECT was that read — accidentally load-bearing.
 * Removing it (PR #2606) made `create()`'s reserve the first operation of the
 * request and exposed the hang. The fix belongs here, not in a quota.
 *
 * So: run one trivial query to force a connection into `open`, then reserve
 * from it. The timeout is defence-in-depth — under concurrency another caller
 * can still steal the primed connection, and a genuinely exhausted pool must
 * fail loud instead of hanging.
 */
export async function reserveDoltgresConnection(
  sql: Sql,
  opts: { timeoutMs?: number } = {}
): Promise<ReservedSql> {
  const timeoutMs = opts.timeoutMs ?? DOLTGRES_RESERVE_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DoltgresReserveTimeoutError(timeoutMs)),
      timeoutMs
    );
  });

  // The timeout must cover the prime as well as the reserve: on an already
  // exhausted pool the priming query is itself parked on postgres.js's
  // unbounded `queries` backlog, so bounding only the reserve would still hang.
  const acquire = (async () => {
    // PRIME_BEFORE_RESERVE: an ordinary query reaches postgres.js `onopen`,
    // which a cold `reserve()` does not. Never remove without reading the note
    // above.
    await sql.unsafe("SELECT 1");
    return await sql.reserve();
  })();

  try {
    return await Promise.race([acquire, expiry]);
  } catch (error) {
    // The losing `acquire` may still settle later; release its connection so a
    // timed-out call cannot leak a pool slot on top of the failure.
    void acquire.then(
      (conn) => conn.release(),
      () => undefined
    );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
