// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/setup/preflight-db-roles`
 * Purpose: Vitest globalSetup that asserts required PostgreSQL roles exist before stack tests run.
 * Scope: Fails fast with actionable instructions. Read-only — does not create roles.
 * Invariants:
 *   - DATABASE_SERVICE_URL must be set (enforced by Zod schema in server.ts)
 *   - The user in DATABASE_SERVICE_URL must exist as a PostgreSQL role
 *   - Must run after Docker Postgres is healthy, before reset-db
 * Side-effects: IO (single read-only query to Postgres)
 * Links: infra/compose/runtime/postgres-init/provision.sh, docs/spec/database-rls.md
 * @internal
 */

import postgres from "postgres";

// biome-ignore lint/style/noDefaultExport: Vitest globalSetup requires default export
export default async function preflightDbRoles() {
  console.log("\n🔍 Preflight: checking required database roles...");

  const serviceUrl = process.env.DATABASE_SERVICE_URL;
  if (!serviceUrl) {
    throw new Error(
      "DATABASE_SERVICE_URL is not set. Required in all environments per DATABASE_RLS_SPEC.md."
    );
  }

  // Extract the role name from the connection URL
  const parsed = new URL(serviceUrl);
  const serviceRole = decodeURIComponent(parsed.username);
  if (!serviceRole) {
    throw new Error(
      "DATABASE_SERVICE_URL has no username. Expected format: postgresql://<role>:<password>@host:port/db"
    );
  }

  // Connect using DATABASE_URL (the app-role connection) to check if the service role exists
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    throw new Error("DATABASE_URL is not set. Cannot verify service role.");
  }

  const sql = postgres(appUrl, {
    max: 1,
    connection: { application_name: "vitest_preflight_db_roles" },
  });

  try {
    const rows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = ${serviceRole}
    `;

    if (rows.length === 0) {
      throw new Error(
        [
          `❌ Required PostgreSQL role "${serviceRole}" does not exist.`,
          "",
          "This role is created by provision.sh (db-provision container).",
          "Run:",
          "",
          "  pnpm db:setup:test",
        ].join("\n")
      );
    }

    console.log(`✅ Role "${serviceRole}" exists\n`);
  } finally {
    await sql.end();
  }
}
