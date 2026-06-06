// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `nodes/hello-world/drizzle.doltgres`
 * Purpose: Per-node drizzle-kit config for hello-world's Doltgres knowledge plane (`knowledge_node_template`). Schema lives in @cogni/hello-world-doltgres-schema (workspace package); migrations generated here and applied via drizzle-kit's native migrator.
 * Scope: CLI boundary for both `drizzle-kit generate` (authoring, local) and `drizzle-kit migrate` (application, inside hello-world migrator initContainer).
 * Invariants: Schema glob targets ONLY the per-node Doltgres package (nodes/hello-world/packages/doltgres-schema) — NOT globbed by the Postgres drizzle config, preserving dialect separation. Migrations dir is hello-world-owned and checked in. DATABASE_URL must be provided by the caller.
 * Side-effects: IO (drizzle-kit writes to ./nodes/hello-world/app/src/adapters/server/db/doltgres-migrations when generating; writes to the Doltgres server when migrating).
 * Notes: No relative TS imports — drizzle-kit compiles configs to a temp dir, breaking `./app/...`-style paths. All paths are repo-root-relative. DATABASE_URL here points at a Doltgres DSN (knowledge_node_template), not a Postgres DSN.
 * Links: nodes/hello-world/packages/doltgres-schema/AGENTS.md, docs/spec/knowledge-data-plane.md, work/items/task.5077.hello-world-doltgres-substrate.md
 * @internal
 */

import { defineConfig } from "drizzle-kit";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for drizzle-kit (nodes/hello-world/drizzle.doltgres.config.ts). " +
        "Invoke via pnpm db:generate:hello-world:doltgres / db:migrate:hello-world:doltgres which set it from .env.local DOLTGRES_URL_NODE_TEMPLATE.",
    );
  }
  return url;
}

export default defineConfig({
  schema: ["./nodes/hello-world/packages/doltgres-schema/src/**/*.ts"],
  out: "./nodes/hello-world/app/src/adapters/server/db/doltgres-migrations",
  dialect: "postgresql",
  dbCredentials: { url: requireDatabaseUrl() },
  verbose: true,
  strict: true,
});
