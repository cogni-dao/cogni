// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/db/seed-client`
 * Purpose: Service-role database client for test fixture seeding and cleanup.
 * Scope: Provides getSeedDb() — a lazy singleton using DATABASE_SERVICE_URL (BYPASSRLS). Does not provide app-role access or RLS-enforced queries.
 * Invariants: Requires DATABASE_SERVICE_URL in env (set by testcontainers global setup)
 * Side-effects: IO (database connection) — only on first access
 * Links: tests/component/setup/testcontainers-postgres.global.ts
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";

let _seedDb: Database | null = null;

/**
 * Returns a service-role database client (BYPASSRLS) for test fixture
 * seeding and cleanup. Connects via DATABASE_SERVICE_URL.
 */
export function getSeedDb(): Database {
  if (!_seedDb) {
    const url = process.env.DATABASE_SERVICE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_SERVICE_URL not set. Run tests via vitest component config (pnpm test:component)."
      );
    }
    _seedDb = createServiceDbClient(url);
  }
  return _seedDb;
}
