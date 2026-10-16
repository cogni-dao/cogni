// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/service`
 * Purpose: Service-role DB client factory (BYPASSRLS).
 * Scope: Exports createServiceDbClient only. Does not export SYSTEM_ACTOR (now in @cogni/ids/system).
 * Invariants:
 * - MUST NOT be imported from Next.js web runtime code (enforced by dependency-cruiser)
 * - Only drizzle.service-client.ts (getServiceDb singleton) and services/ may import this
 * Side-effects: IO (database connections)
 * Links: docs/spec/database-rls.md
 * @public
 */

import { buildClient, type DbClientOptions } from "./build-client";

/**
 * Creates a Drizzle database client for the `app_service` role (BYPASSRLS).
 * Use this for scheduler workers, internal services, and auth bootstrap only.
 * Must NOT be used in the Next.js web runtime (enforced by dependency-cruiser).
 */
export function createServiceDbClient(
  connectionString: string,
  options?: DbClientOptions
) {
  return buildClient(connectionString, "cogni_service", options);
}
