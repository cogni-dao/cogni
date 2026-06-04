// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/setup/testcontainers-postgres.global`
 * Purpose: Vitest global setup for testcontainers-based PostgreSQL component tests.
 * Scope: Manages PostgreSQL container lifecycle with proper role separation via provision.sh. Does not run application code or tests directly.
 * Invariants:
 *   - Runs provision.sh inside the container (psql available there, not on host)
 *   - DATABASE_URL → app_user (RLS-enforced, DB owner)
 *   - DATABASE_SERVICE_URL → app_service (BYPASSRLS)
 *   - Migrations run as app_user (DB owner, same as production)
 * Side-effects: IO (Docker containers, process.env, file system)
 * Notes: Used by vitest.component.config.mts as globalSetup; sets APP_ENV=test for fake adapters.
 * Links: vitest component config, infra/compose/runtime/postgres-init/provision.sh
 * @internal
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

import { CORE_TEST_ENV } from "../../_fixtures/env/base-env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVISION_SH = path.resolve(
  __dirname,
  "../../../../../../infra/compose/runtime/postgres-init/provision.sh"
);

const APP_DB_USER = "app_user";
const APP_DB_PASSWORD = "app_user_pass";
const APP_DB_SERVICE_USER = "app_service";
const APP_DB_SERVICE_PASSWORD = "service_pass";
const APP_DB_NAME = "app_test_db";

export async function setup() {
  // Start Postgres with provision.sh copied into the container
  const c = await new PostgreSqlContainer("postgres:15-alpine")
    .withCopyFilesToContainer([
      { source: PROVISION_SH, target: "/tmp/provision.sh" },
    ])
    .start();

  const superuser = c.getUsername();
  const superpass = c.getPassword();

  // Run provision.sh inside the container (where psql is available).
  // Creates app_user (DB owner, RLS enforced) + app_service (BYPASSRLS),
  // creates APP_DB_NAME database, grants DML to both roles.
  // Install bash in alpine container (postgres:15-alpine ships only ash)
  await c.exec(["sh", "-c", "apk add --no-cache bash > /dev/null 2>&1"]);

  const result = await c.exec([
    "bash",
    "-c",
    [
      `DB_HOST=localhost`,
      `DB_PORT=5432`,
      `POSTGRES_ROOT_USER=${superuser}`,
      `POSTGRES_ROOT_PASSWORD=${superpass}`,
      `COGNI_NODE_DBS=${APP_DB_NAME}`,
      `LITELLM_DB_NAME=litellm_test`,
      `APP_DB_NAME=${APP_DB_NAME}`,
      `APP_DB_USER=${APP_DB_USER}`,
      `APP_DB_PASSWORD=${APP_DB_PASSWORD}`,
      `APP_DB_SERVICE_USER=${APP_DB_SERVICE_USER}`,
      `APP_DB_SERVICE_PASSWORD=${APP_DB_SERVICE_PASSWORD}`,
      `bash /tmp/provision.sh`,
    ].join(" "),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `provision.sh failed (exit ${result.exitCode}):\n${result.output}`
    );
  }

  // Build role-separated connection URIs against the provisioned database
  const host = c.getHost();
  const port = c.getMappedPort(5432);
  const appUserUri = `postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${host}:${port}/${APP_DB_NAME}`;
  const serviceUserUri = `postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@${host}:${port}/${APP_DB_NAME}`;

  Object.assign(process.env, {
    ...CORE_TEST_ENV,
    DATABASE_URL: appUserUri,
    DATABASE_SERVICE_URL: serviceUserUri,
    APP_ENV: "test",
  });

  // Run migrations as app_user (DB owner, same as production)
  execSync("pnpm -w db:migrate:direct", { stdio: "inherit" });

  // ── Preflight: verify service role can connect (BYPASSRLS) ─────────────
  const serviceCheck = await c.exec([
    "bash",
    "-c",
    `PGPASSWORD='${APP_DB_SERVICE_PASSWORD}' psql -h localhost -p 5432 -U ${APP_DB_SERVICE_USER} -d ${APP_DB_NAME} -tAc "SELECT current_user"`,
  ]);
  const serviceUser = serviceCheck.output.trim();
  if (serviceCheck.exitCode !== 0 || serviceUser !== APP_DB_SERVICE_USER) {
    throw new Error(
      `Preflight failed: cannot connect as ${APP_DB_SERVICE_USER}. ` +
        `provision.sh may not have created the service role.\n${serviceCheck.output}`
    );
  }

  // ── Preflight: every table with ENABLE RLS must also have FORCE RLS ───
  // Derived from pg_class — no hardcoded list; catches drift automatically.
  // If a table has relrowsecurity but NOT relforcerowsecurity, the DB owner
  // (app_user) would bypass RLS, causing false-green tests.
  const rlsCheck = await c.exec([
    "bash",
    "-c",
    `PGPASSWORD='${APP_DB_PASSWORD}' psql -h localhost -p 5432 -U ${APP_DB_USER} -d ${APP_DB_NAME} -tAc "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity"`,
  ]);
  const missingForceRls = rlsCheck.output
    .trim()
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (missingForceRls.length > 0) {
    throw new Error(
      `Preflight failed: tables have ENABLE RLS but missing FORCE RLS: ${missingForceRls.join(", ")}. ` +
        `The DB owner (${APP_DB_USER}) will bypass RLS without FORCE.`
    );
  }

  // Sanity: at least one table should have RLS enabled (catch missing migration)
  const rlsCountCheck = await c.exec([
    "bash",
    "-c",
    `PGPASSWORD='${APP_DB_PASSWORD}' psql -h localhost -p 5432 -U ${APP_DB_USER} -d ${APP_DB_NAME} -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity"`,
  ]);
  const rlsTableCount = parseInt(rlsCountCheck.output.trim(), 10);
  if (!rlsTableCount || rlsTableCount === 0) {
    throw new Error(
      "Preflight failed: no tables have RLS enabled. Migration 0004_enable_rls.sql may not have run."
    );
  }

  return async () => {
    await c.stop();
  };
}
