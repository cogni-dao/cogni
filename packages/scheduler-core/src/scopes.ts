// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/scopes`
 * Purpose: The single mint and checker for execution-grant scope strings (graph and node-task).
 *   Covers graph scopes (`graph:execute:<graphId>`) and node-task scopes
 *   (`task:dispatch:<nodeId>:<route>`). Centralized so M2's `validateGrantForScope`
 *   has ONE checker for both, and M1's grant↔node binding is structural (the
 *   nodeId is embedded in the task scope; the grants table has no node_id column).
 * Scope: Pure string functions and a pure predicate; does not perform I/O, zod parsing, or drizzle access.
 * Invariants:
 *   - SCOPE_IS_NODE_BOUND (M1): a node-task scope embeds its nodeId — a grant
 *     minted for node A can never authorize a dispatch to node B.
 *   - SCOPE_SINGLE_MINT (M2): never hand-format a scope string; derive from here.
 * Side-effects: none
 * Links: docs/design/node-temporal-tenant-interface.md (task.5029, M1+M2), execution-grant.port.ts
 * @public
 */

/** Graph-execution scope for a graphId. */
export function graphExecuteScope(graphId: string): string {
  return `graph:execute:${graphId}`;
}

/** Graph-execution wildcard scope (any graph). */
export function graphExecuteWildcardScope(): string {
  return "graph:execute:*";
}

/**
 * Node-task dispatch scope (M1): `task:dispatch:<nodeId>:<route>`. The nodeId is
 * embedded so grant↔node binding is structural without a node_id column.
 */
export function nodeTaskScope(nodeId: string, route: string): string {
  return `task:dispatch:${nodeId}:${route}`;
}

/** Node-task wildcard scope: `task:dispatch:<nodeId>:*` (any route on one node). */
export function nodeTaskWildcardScope(nodeId: string): string {
  return `task:dispatch:${nodeId}:*`;
}

const NODE_TASK_PREFIX = "task:dispatch:";

/**
 * Parse a node-task scope into `{ nodeId, route }`, or `null` if it is not a
 * node-task scope. Used by validation to assert the embedded nodeId binding (M1).
 *
 * `task:dispatch:<nodeId>:<route>` — the route may itself contain colons (it is
 * a path), so we split on the FIRST colon after the prefix only.
 */
export function parseNodeTaskScope(
  scope: string
): { nodeId: string; route: string } | null {
  if (!scope.startsWith(NODE_TASK_PREFIX)) return null;
  const rest = scope.slice(NODE_TASK_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return { nodeId: rest.slice(0, sep), route: rest.slice(sep + 1) };
}

/**
 * Outcome of checking a grant's scopes against a required scope (M2). Pure —
 * the adapter maps `false`/`node_mismatch` to the right typed error.
 *
 *  - `ok`            → an exact or wildcard scope grants the action.
 *  - `node_mismatch` → the grant holds a node-task scope for a DIFFERENT node
 *                      than the one being dispatched (M1 security violation).
 *  - `scope_mismatch`→ no scope (exact or wildcard) authorizes the action.
 */
export type ScopeCheckResult = "ok" | "node_mismatch" | "scope_mismatch";

/**
 * The single scope checker (M2). Given the grant's scopes, the required scope,
 * and the node the worker is dispatching for, decide whether the dispatch is
 * authorized. Honors the node-bound wildcard (`task:dispatch:<nodeId>:*`) and
 * the graph wildcard (`graph:execute:*`), and enforces the M1 grant↔node binding
 * for node-task scopes.
 */
export function validateGrantScope(
  scopes: readonly string[],
  requiredScope: string,
  nodeId: string
): ScopeCheckResult {
  const required = parseNodeTaskScope(requiredScope);

  // Node-task path (M1): the required scope is node-bound. The grant must hold
  // either the exact scope or the node's own wildcard, AND every node-task
  // scope it holds for THIS action must be bound to the dispatched nodeId.
  if (required) {
    // Defensive: the required scope's embedded nodeId must match the dispatch.
    if (required.nodeId !== nodeId) return "node_mismatch";

    const exact = requiredScope;
    const wildcard = nodeTaskWildcardScope(nodeId);
    if (scopes.includes(exact) || scopes.includes(wildcard)) return "ok";

    // The grant holds a node-task scope, but for a different node → M1 breach.
    for (const s of scopes) {
      const parsed = parseNodeTaskScope(s);
      if (parsed && parsed.nodeId !== nodeId) return "node_mismatch";
    }
    return "scope_mismatch";
  }

  // Graph path (back-compat): exact graphId scope or graph wildcard.
  if (
    scopes.includes(requiredScope) ||
    scopes.includes(graphExecuteWildcardScope())
  ) {
    return "ok";
  }
  return "scope_mismatch";
}
