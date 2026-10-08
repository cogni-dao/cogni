// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/build-client`
 * Purpose: Factory for creating a postgres.js client configured for Doltgres.
 * Scope: Connection factory only. Does not load env vars, manage lifecycle, or acquire session-pinned connections.
 * Invariants:
 *   - Connection string injected, never from process.env (PACKAGES_NO_ENV).
 *   - `fetch_types: false` is mandatory for Doltgres and is what makes
 *     `PRIME_BEFORE_RESERVE` load-bearing — see `DoltBranchSessionRunner`.
 *   - Nothing in this package may call `sql.reserve()` directly; session-pinned
 *     work goes through `DoltBranchSessionRunner`, which bounds concurrency
 *     above the pool so a burst cannot wedge it (bug.5386, bug.5391).
 * Side-effects: IO (database connections)
 * Links: docs/spec/knowledge-data-plane.md, packages/knowledge-store/src/adapters/doltgres/session-admission.ts
 * @public
 */

import postgres from "postgres";

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
