// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@infra/drizzle.control.config`
 * Purpose: Generate the root-owned administrative containment schema independently of node application migrations.
 * Scope: Drizzle CLI configuration only; does not establish runtime database connections or migrate node application tables.
 * Invariants: The control schema and migration output remain excluded from application schema globs and barrels.
 * Side-effects: none
 * Links: packages/db-schema/infra-control.ts, docs/spec/databases.md
 * @internal
 */
import { defineConfig } from "drizzle-kit";

// Administrative postgres only. This schema is excluded from all app migrators.
export default defineConfig({
  schema: "./packages/db-schema/infra-control.ts",
  out: "./infra/compose/runtime/postgres-init/control-migrations",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://generate@localhost:0/postgres" },
  verbose: true,
  strict: true,
});
