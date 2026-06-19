// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/node-rbac`
 * Purpose: The ONE seam for node-scoped route authorization. Resolve a node `{id}`
 *   (repo-spec `node_id` UUID OR slug) **status-agnostically** via `resolveNodeRef`
 *   (the #1766 resolver — a dev's node is `published` long before `active`, so
 *   authorization, not registry status, gates access), then run the OpenFGA check for
 *   `action` on `node:<id>`. Secrets / flight-status / assert-live / observability all
 *   shared this block by copy-paste — and 3 of them still used the **active-only**
 *   `resolveNodeRegistry().listPublic()`, 404-ing published-not-active nodes. This
 *   retires the copy-paste AND converges every route onto the correct resolver.
 * Scope: pure route helper — returns a discriminated result (resolved node OR a typed
 *   failure) so each caller keeps its own structured logging + body shape. Does NOT
 *   log, does NOT build the NextResponse (the route owns those).
 * Invariants:
 *   - NODE_BY_ID_OR_SLUG, STATUS_AGNOSTIC: `resolveNodeRef` over a service-role db.
 *   - OPENFGA_FAIL_CLOSED: no authority configured → `authz_unavailable` (caller 503);
 *     `not-allow` → `authz_denied` (caller 403). Never owner-fallback.
 *   - RESOURCE_FROM_RESOLVED_NODE: the OpenFGA `resource` is `node:<resolved nodeId>`,
 *     never the raw URL param (closes the node-pollination axis).
 * Side-effects: IO (service-db read, OpenFGA check).
 * Links: src/features/nodes/node-lookup.ts (resolveNodeRef),
 *   src/app/api/v1/nodes/[id]/{secrets,flight-status,assert-live,observability/logs}/route.ts
 * @public
 */

import type { AuthzAction } from "@cogni/authorization-core";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import {
  type ResolvedNodeRef,
  resolveNodeRef,
} from "@/features/nodes/node-lookup";

/** Why a node-scoped authz attempt failed, with the HTTP status the route returns. */
export type NodeRbacFailure = {
  readonly ok: false;
  readonly status: 404 | 503 | 403;
  readonly errorCode: "node_not_found" | "authz_unavailable" | "authz_denied";
  /** The resolved slug, present when the node resolved but authz failed (for logging). */
  readonly slug?: string | undefined;
};

export type NodeRbacResult =
  | { readonly ok: true; readonly node: ResolvedNodeRef }
  | NodeRbacFailure;

/**
 * Resolve `id` (node UUID or slug) and authorize `action` on it for `userId`.
 * Returns the resolved node on allow, or a typed failure the caller logs + maps to a
 * response. Fail-closed throughout.
 */
export async function resolveNodeAndAuthorize(input: {
  readonly id: string;
  readonly userId: string;
  readonly action: AuthzAction;
}): Promise<NodeRbacResult> {
  const node = await resolveNodeRef(resolveServiceDb(), input.id);
  if (!node) {
    return { ok: false, status: 404, errorCode: "node_not_found" };
  }

  const authorization = getContainer().authorization;
  if (!authorization) {
    return {
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      slug: node.slug,
    };
  }

  const decision = await authorization.check({
    actorId: `user:${input.userId}`,
    action: input.action,
    resource: `node:${node.nodeId}`,
    context: { tenantId: node.nodeId, nodeId: node.nodeId },
  });
  if (decision.decision !== "allow") {
    return decision.code === "authz_unavailable"
      ? {
          ok: false,
          status: 503,
          errorCode: "authz_unavailable",
          slug: node.slug,
        }
      : { ok: false, status: 403, errorCode: "authz_denied", slug: node.slug };
  }

  return { ok: true, node };
}
