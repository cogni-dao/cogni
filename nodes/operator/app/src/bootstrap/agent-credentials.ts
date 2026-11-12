// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client plus the operator's
 *   `hasRoles` read (BINDING_BEFORE_UPGRADE spans BOTH planes here: OpenFGA deploy tuples and `agent_roles` rows).
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. It does not decide anything. The package reserves the `hasRoles` seam for exactly this
 *   operator injection (its Postgres default reads `agent_roles` alone).
 * Invariants:
 *   - FAIL_CLOSED_ROLES: an OpenFGA outage during the roles read is a store outage (503), never "no roles" (which would let a
 *     deploy-role principal upgrade without its GitHub binding, task.5474 C5).
 * Side-effects: none (clients are built lazily); the per-client lookup limiter is in-memory
 * Links: https://cognidao.org/work/items/story.5156
 * @internal
 */

import { authzUserResource } from "@cogni/authorization-core";
import {
  agentRolesHasRoles,
  type CredentialSql,
  type CredentialState,
  type CredentialStore,
  CredentialStoreUnavailableError,
  createPostgresCredentialStore,
  type HasRoles,
  verifyBearer,
} from "@cogni-dao/agent-grants/credentials";

import { resolveServiceDb } from "@/bootstrap/container";
import {
  credentialLookupLimiter,
  extractEdgeClientIp,
} from "@/bootstrap/http/rateLimiter";

let store: CredentialStore | undefined;

/** OpenFGA deploy tuples OR agent_roles rows (operator-only composition; node-template reads agent_roles alone). Exported for its unit test. */
export function operatorHasRoles(client: CredentialSql): HasRoles {
  const sqlRoles = agentRolesHasRoles(client);
  return async (userId: string) => {
    if (await sqlRoles(userId)) return true;
    const { getContainer } = await import("@/bootstrap/container");
    const authorization = getContainer().authorization;
    if (!authorization)
      throw new CredentialStoreUnavailableError(
        new Error("no_authz_adapter for hasRoles")
      );
    const listed = await authorization.listRelations(authzUserResource(userId));
    if (listed.decision !== "success")
      throw new CredentialStoreUnavailableError(
        new Error("authz_list_unavailable for hasRoles")
      );
    return listed.tuples.length > 0;
  };
}

/** A missing or broken service connection is an outage (503), never a 500 or a 401. */
export function getAgentCredentialStore(): CredentialStore {
  try {
    const client = resolveServiceDb().$client as unknown as CredentialSql;
    store ??= createPostgresCredentialStore(client, {
      hasRoles: operatorHasRoles(client),
    });
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
  return store;
}

/**
 * Compose node admission with the package verifier. Reserve synchronously in its
 * admit hook, charge only its invalid hook, and release on every terminal path.
 * Package shape, checksum, state and outage semantics remain authoritative.
 */
export async function verifyAgentCredential(
  credentialStore: CredentialStore,
  token: string,
  allow: readonly CredentialState[],
  headers: { get(name: string): string | null }
) {
  const key = extractEdgeClientIp({ headers });
  const admission: { release: (() => void) | null } = { release: null };
  try {
    return await verifyBearer(credentialStore, token, allow, {
      admit: () => {
        admission.release = credentialLookupLimiter.reserve(key);
        return admission.release !== null;
      },
      onInvalid: () => {
        credentialLookupLimiter.consume(key);
      },
    });
  } finally {
    admission.release?.();
  }
}
