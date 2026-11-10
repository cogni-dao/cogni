// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client.
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. It does not decide anything. 1-1 port of node-template bootstrap/agent-credentials.ts (story.5156).
 * Side-effects: none (the client is built lazily)
 * Links: https://cognidao.org/work/items/story.5156
 * @internal
 */

import {
  type CredentialSql,
  type CredentialStore,
  CredentialStoreUnavailableError,
  createPostgresCredentialStore,
} from "@cogni-dao/agent-grants/credentials";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";

let store: CredentialStore | undefined;

/** A missing or broken service connection is an outage (503), never a 500 or a 401. */
export function getAgentCredentialStore(): CredentialStore {
  try {
    store ??= createPostgresCredentialStore(
      getServiceDb().$client as unknown as CredentialSql
    );
  } catch {
    throw new CredentialStoreUnavailableError();
  }
  return store;
}
