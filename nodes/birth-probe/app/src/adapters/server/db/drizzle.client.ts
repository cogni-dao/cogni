// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle.client`
 * Purpose: Lazy app-role database singleton (RLS enforced) for the Next.js web runtime.
 * Scope: Wraps createAppDbClient with env-derived connection string. Does not handle business logic, migrations, or service-role access.
 * Invariants: Single database connection instance; lazy initialization prevents build-time env access
 * Side-effects: IO (database connections) - only on first access
 * Notes: Service-role singleton (BYPASSRLS) lives in drizzle.service-client.ts, NOT here.
 * Links: docs/spec/database-rls.md
 * @internal
 */

import { createAppDbClient, type Database } from "@cogni/db-client";

import { serverEnv } from "@/shared/env";

export type { Database };

// Lazy database connection - only created when first accessed
let _db: Database | null = null;

function createDb(): Database {
  if (!_db) {
    _db = createAppDbClient(serverEnv().DATABASE_URL);
  }
  return _db;
}

// Export lazy database getter to avoid top-level runtime env access
export const getAppDb = createDb;
