// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `nodes/canary/drizzle.config`
 * Purpose: Per-node drizzle-kit config for the canary scaffold — core schema only.
 * Scope: Drizzle-kit CLI boundary. Forks duplicate this config when copying nodes/canary to nodes/<fork>.
 * Invariants: Core schema only — node-local tables are added post-fork via a schema array extension. DATABASE_URL must be provided by caller.
 * Side-effects: IO (drizzle-kit writes to ./nodes/canary/app/src/adapters/server/db/migrations).
 * Notes: canary is not deployed; this file exists so the fork workflow has a working template. No relative imports — drizzle-kit compiles configs to a temp dir, breaking `./app/...`-style paths. All paths are repo-root-relative.
 * Links: work/items/task.0324.per-node-db-schema-independence.md
 * @internal
 */

import { defineConfig } from "drizzle-kit";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for drizzle-kit (nodes/canary/drizzle.config.ts). " +
        "Forks must invoke via a caller that sets DATABASE_URL from their .env file or container env.",
    );
  }
  return url;
}

export default defineConfig({
  schema: "./packages/db-schema/src/**/*.ts",
  out: "./nodes/canary/app/src/adapters/server/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: requireDatabaseUrl() },
  verbose: true,
  strict: true,
});
