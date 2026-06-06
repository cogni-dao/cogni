// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db`
 * Purpose: Barrel export for database schema.
 * Scope: Exposes database schema only. Does not handle connections or migrations.
 * Invariants: Only re-exports public APIs; maintains type safety.
 * Side-effects: none
 * Notes: Used by adapters for database operations. buildDatabaseUrl is NOT exported here —
 *        it lives in db-url.ts for tooling-only use (drizzle.config.ts, test scripts).
 *        Per DATABASE_RLS_SPEC.md design decision 7: no DSN construction in runtime code.
 * Links: docs/spec/database-rls.md
 * @public
 */

export * from "./schema";
