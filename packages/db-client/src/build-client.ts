// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/build-client`
 * Purpose: Shared Drizzle client constructor used by both app and service factories.
 * Scope: Internal — not exported from any package entrypoint. Does not handle env resolution.
 * Invariants:
 *   - Connection string injected, never from process.env
 *   - Database type preserves drizzle's `$client` accessor for pool control (e.g. `reserve()`)
 * Side-effects: IO (database connections)
 * Links: docs/spec/database-rls.md
 * @internal
 */

import type { Socket } from "node:net";
import * as fullSchema from "@cogni/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export interface DbClientOptions {
  /** Maximum connections owned by this process, not the database role's limit. */
  readonly max?: number;
  readonly applicationName?: string;
  /** Disable automatic catalog array-type discovery when the consumer uses no SQL arrays. */
  readonly fetchTypes?: boolean;
  /** Documented postgres.js custom transport; its owner must dispose it after end(). */
  readonly socket?: () => Promise<Socket>;
  /** Public postgres.js TLS options, including an explicit SNI name for custom sockets. */
  readonly ssl?: postgres.Options<Record<string, never>>["ssl"];
}

export function buildClient(
  connectionString: string,
  applicationName: string,
  options: DbClientOptions = {}
) {
  const max = options.max ?? 10;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error("Database pool max must be a positive safe integer");
  }
  // v3.4.7 supports socket at runtime but omits it from its public declarations.
  const transportOptions: postgres.Options<Record<string, never>> & {
    socket?: () => Promise<Socket>;
  } = {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(options.fetchTypes !== undefined
      ? { fetch_types: options.fetchTypes }
      : {}),
    ...(options.socket ? { socket: options.socket } : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    connection: {
      application_name: options.applicationName ?? applicationName,
    },
  };
  const client = postgres(connectionString, transportOptions);

  return drizzle(client, { schema: fullSchema });
}

/** Drizzle client including the postgres.js `$client` accessor for pool control. */
export type Database = ReturnType<typeof buildClient>;
