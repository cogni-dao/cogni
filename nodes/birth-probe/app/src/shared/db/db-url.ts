// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/db-url`
 * Purpose: Database URL construction utility for PostgreSQL connections — tooling only.
 * Scope: Constructs DATABASE_URL from env pieces for tooling scripts. Does not handle connections or runtime validation.
 * Invariants: Pure function; no Next.js/Zod deps; requires POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, DB_HOST.
 * Side-effects: none
 * Notes: Tooling only (drizzle.config.ts, reset-db.ts, drop-test-db.ts). NOT in barrel — import from `@/shared/db/db-url`.
 * Links: docs/spec/database-rls.md (design decision 7)
 * @public
 */

export interface DbEnvInput {
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
  DB_HOST?: string;
  DB_PORT?: string | number;
}

export function buildDatabaseUrl(env: DbEnvInput): string {
  const user = env.POSTGRES_USER;
  const password = env.POSTGRES_PASSWORD;
  const db = env.POSTGRES_DB;
  const host = env.DB_HOST;
  const port =
    typeof env.DB_PORT === "number"
      ? env.DB_PORT
      : Number(env.DB_PORT ?? "5432");

  if (!user || !password || !db) {
    throw new TypeError(
      "Missing required DB env vars: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB"
    );
  }

  if (!host) {
    throw new TypeError("Missing required DB env var: DB_HOST");
  }

  if (!Number.isFinite(port)) {
    throw new TypeError(`Invalid DB_PORT value: ${env.DB_PORT}`);
  }

  const base = `postgresql://${user}:${password}@${host}:${port}/${db}`;

  // Per DATABASE_RLS_SPEC.md §SSL_REQUIRED_NON_LOCAL: non-localhost connections
  // must use sslmode=require (or stricter) to prevent credential sniffing.
  const isLocalhost = host === "localhost" || host === "127.0.0.1";
  if (!isLocalhost) {
    return `${base}?sslmode=require`;
  }

  return base;
}
