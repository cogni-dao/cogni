// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/client`
 * Purpose: App-role database client factory (RLS enforced).
 * Scope: Creates Drizzle database instance for app_user role. Does not read from environment.
 * Invariants:
 * - Connection string injected, never from process.env
 * - FORBIDDEN: @/shared/env, process.env, Next.js imports
 * - createServiceDbClient lives in service.ts, NOT here
 * Side-effects: IO (database connections)
 * Links: docs/spec/packages-architecture.md, docs/spec/database-rls.md
 * @public
 */

import {
  buildClient,
  type Database,
  type DbClientOptions,
} from "./build-client";

export type { Database, DbClientOptions };

/**
 * Simple logger interface for optional logging in adapters.
 * Consumers can inject their own logger (e.g., pino).
 */
export interface LoggerLike {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Creates a Drizzle database client for the `app_user` role (RLS enforced).
 * Use this for all user-facing request paths.
 */
export function createAppDbClient(
  connectionString: string,
  options?: DbClientOptions
) {
  return buildClient(connectionString, "cogni_template_app", options);
}
