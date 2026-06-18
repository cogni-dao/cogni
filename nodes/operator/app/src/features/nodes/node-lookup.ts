// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/node-lookup`
 * Purpose: One place that decides how a public node `{id}` path segment resolves against the `nodes`
 *   table — by repo-spec `node_id` (== `nodes.id`, the operator's projection of the deployment-identity
 *   SSOT) OR by the human/agent-friendly `slug`. Keeps the two forms consistent across every route so
 *   they cannot drift on what `{id}` means.
 * Scope: A SQL-condition builder + a service-role resolver; the caller owns the DB/scope (RLS or
 *   service-role) and any ownership predicate. Resolve the row, then use `nodes.id` for OpenFGA / Loki
 *   — never the raw path segment, which may be a slug. Resolution is status-agnostic: a node dev's node
 *   is `published` long before it is `active`, so authorization (not registry status) gates access.
 * Invariants: ADDRESS_BY_SLUG_OR_NODE_ID, AUTHORITY_IS_NODE_ID — `slug` addresses; the UUID
 *   (`nodes.id` = repo-spec `node_id`) is the authority that reaches OpenFGA tuples and Loki labels.
 * Side-effects: none (pure)
 * Links: docs/spec/identity-model.md (OPERATOR_NODE_ROW_ID_IS_NODE_ID), src/shared/db/nodes.ts
 * @public
 */

import type { Database } from "@cogni/db-client";
import { eq, or, type SQL } from "drizzle-orm";

import { nodes } from "@/shared/db/nodes";

/** The canonical identity of one node, resolved from a `{id}` path segment. */
export interface ResolvedNodeRef {
  /** repo-spec `node_id` (= `nodes.id`) — the authority for OpenFGA + the Loki `node` label. */
  readonly nodeId: string;
  /** Human/agent addressing handle. */
  readonly slug: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the string is a canonical UUID (a candidate repo-spec `node_id` / `nodes.id`). */
export function isNodeId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Drizzle `WHERE` fragment matching one node by its repo-spec `node_id` (`nodes.id`) OR its `slug`.
 * Compose it into a route's existing `and(...)` (e.g. with an owner predicate). Only the `id` term is
 * emitted when the segment is UUID-shaped, so a slug never reaches Postgres as a malformed uuid cast.
 */
export function nodeIdOrSlug(idOrSlug: string): SQL {
  if (isNodeId(idOrSlug)) {
    // `or(...)` is non-undefined here (two defined terms); assert for the SQL return type.
    return or(eq(nodes.id, idOrSlug), eq(nodes.slug, idOrSlug)) as SQL;
  }
  return eq(nodes.slug, idOrSlug);
}

/**
 * Resolve a public `{id}` segment (repo-spec `node_id` OR `slug`) to one node's canonical identity,
 * regardless of registry status. Pass a SERVICE-ROLE db (bypasses RLS): a node developer addressing
 * their own node must resolve it whether it is `published`, `active`, or anything else — the
 * `node.flight` OpenFGA check (not the registry status, and not the active-only public showcase)
 * gates access. Returns `null` when no node matches.
 */
export async function resolveNodeRef(
  db: Database,
  idOrSlug: string
): Promise<ResolvedNodeRef | null> {
  const rows = await db
    .select({ id: nodes.id, slug: nodes.slug })
    .from(nodes)
    .where(nodeIdOrSlug(idOrSlug))
    .limit(1);
  const row = rows[0];
  return row ? { nodeId: row.id, slug: row.slug } : null;
}
