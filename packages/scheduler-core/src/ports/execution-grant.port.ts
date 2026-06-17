// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/execution-grant`
 * Purpose: Execution grant port interfaces split by trust boundary (user vs worker).
 * Scope: Defines contracts for durable grants that authorize scheduled runs (not user sessions).
 * Invariants:
 * - Per GRANT_NOT_SESSION: Workers authenticate via grants, never user sessions
 * - Per GRANT_SCOPES_CONSTRAIN_GRAPHS: Scopes specify which graphIds can execute
 * - Scope format: "graph:execute:{graphId}" or "graph:execute:*" for wildcard
 * Side-effects: none (interface definition only)
 * Links: docs/spec/scheduler.md, types/scheduling.ts, DrizzleExecutionGrantAdapter
 * @public
 */

import type { ActorId, UserId } from "@cogni/ids";
import type { ExecutionGrant } from "../types";

// Re-export type for adapter convenience
export type { ExecutionGrant } from "../types";

/**
 * Port-level error thrown when grant is not found.
 */
export class GrantNotFoundError extends Error {
  constructor(public readonly grantId: string) {
    super(`Execution grant not found: ${grantId}`);
    this.name = "GrantNotFoundError";
  }
}

/**
 * Port-level error thrown when grant has expired.
 */
export class GrantExpiredError extends Error {
  constructor(
    public readonly grantId: string,
    public readonly expiresAt: Date
  ) {
    super(`Execution grant expired: ${grantId} at ${expiresAt.toISOString()}`);
    this.name = "GrantExpiredError";
  }
}

/**
 * Port-level error thrown when grant has been revoked.
 */
export class GrantRevokedError extends Error {
  constructor(
    public readonly grantId: string,
    public readonly revokedAt: Date
  ) {
    super(`Execution grant revoked: ${grantId} at ${revokedAt.toISOString()}`);
    this.name = "GrantRevokedError";
  }
}

/**
 * Port-level error thrown when grant scope does not include the requested
 * scope. Generalized (M2, task.5029) from the original graph-only mismatch:
 * `requiredScope` is any scope string (`graph:execute:<id>` or
 * `task:dispatch:<nodeId>:<route>`). The legacy `graphId` accessor is retained
 * (derives from the scope tail) so existing call sites + tests keep compiling.
 */
export class GrantScopeMismatchError extends Error {
  constructor(
    public readonly grantId: string,
    public readonly requiredScope: string,
    public readonly scopes: readonly string[]
  ) {
    super(
      `Grant ${grantId} does not authorize scope ${requiredScope}. Scopes: ${scopes.join(", ")}`
    );
    this.name = "GrantScopeMismatchError";
  }

  /** Back-compat: the requested action identifier (graphId or route). */
  get graphId(): string {
    return this.requiredScope;
  }
}

/**
 * Port-level error thrown when a grant's embedded node binding does not match
 * the node a worker is dispatching for (M1, task.5029 — grant↔node binding).
 * The grants table has no `node_id` column; the binding is structural in the
 * scope string (`task:dispatch:<nodeId>:<route>`), so a grant minted for node A
 * can never authorize a dispatch to node B even if its grantId leaks. This is a
 * security-blocker close — fail closed, non-retryable.
 */
export class GrantNodeMismatchError extends Error {
  constructor(
    public readonly grantId: string,
    public readonly expectedNodeId: string
  ) {
    super(
      `Grant ${grantId} is not bound to node ${expectedNodeId} (grant↔node binding)`
    );
    this.name = "GrantNodeMismatchError";
  }
}

export function isGrantNotFoundError(
  error: unknown
): error is GrantNotFoundError {
  return error instanceof Error && error.name === "GrantNotFoundError";
}

export function isGrantExpiredError(
  error: unknown
): error is GrantExpiredError {
  return error instanceof Error && error.name === "GrantExpiredError";
}

export function isGrantRevokedError(
  error: unknown
): error is GrantRevokedError {
  return error instanceof Error && error.name === "GrantRevokedError";
}

export function isGrantScopeMismatchError(
  error: unknown
): error is GrantScopeMismatchError {
  return error instanceof Error && error.name === "GrantScopeMismatchError";
}

export function isGrantNodeMismatchError(
  error: unknown
): error is GrantNodeMismatchError {
  return error instanceof Error && error.name === "GrantNodeMismatchError";
}

/**
 * User-facing grant operations. callerUserId required for RLS scoping.
 * Constructed with appDb (RLS enforced).
 * Function properties (not methods) for contravariant param checking on branded types.
 */
export interface ExecutionGrantUserPort {
  /**
   * Creates a new execution grant for scheduled runs.
   * input.userId is the tenant scope for RLS.
   * Note: virtualKeyId is resolved at runtime via AccountService, not stored in grant.
   */
  createGrant: (input: {
    userId: UserId;
    billingAccountId: string;
    scopes: readonly string[];
    expiresAt?: Date;
  }) => Promise<ExecutionGrant>;

  /** Revokes a grant (soft delete via revoked_at timestamp). */
  revokeGrant: (callerUserId: UserId, grantId: string) => Promise<void>;

  /**
   * Deletes a grant permanently (hard delete).
   * Used for atomicity cleanup when schedule creation fails.
   */
  deleteGrant: (callerUserId: UserId, grantId: string) => Promise<void>;

  /**
   * Find existing valid (non-revoked, non-expired) grant or create one. Idempotent.
   * Used by governance sync to ensure a stable grant exists for system-ops schedules.
   * Advisory lock recommended at the call site to prevent concurrent races.
   */
  ensureGrant: (input: {
    userId: UserId;
    billingAccountId: string;
    scopes: readonly string[];
  }) => Promise<ExecutionGrant>;
}

/**
 * Worker-only grant validation. actorId required for audit trail.
 * Constructed with serviceDb (BYPASSRLS) — setTenantContext is no-op but keeps invariant uniform.
 * Function properties (not methods) for contravariant param checking on branded types.
 */
export interface ExecutionGrantWorkerPort {
  /**
   * Validates grant exists and is not expired/revoked.
   * @throws GrantNotFoundError, GrantExpiredError, GrantRevokedError
   */
  validateGrant: (actorId: ActorId, grantId: string) => Promise<ExecutionGrant>;

  /**
   * Generalized grant validation (M2, task.5029). Asserts:
   *  1. the grant exists and is not expired/revoked,
   *  2. the grant holds `requiredScope` (or its node-bound / graph wildcard),
   *  3. (M1 grant↔node binding) the grant is bound to `nodeId` — for
   *     node-task scopes the nodeId is embedded in the scope string
   *     (`task:dispatch:<nodeId>:<route>`), so a grant minted for one node can
   *     never authorize a dispatch to another even if its grantId leaks.
   *
   * `validateGrantForGraph` is a thin back-compat wrapper over this.
   * @throws GrantNotFoundError, GrantExpiredError, GrantRevokedError, GrantScopeMismatchError, GrantNodeMismatchError
   */
  validateGrantForScope: (
    actorId: ActorId,
    nodeId: string,
    grantId: string,
    requiredScope: string
  ) => Promise<ExecutionGrant>;

  /**
   * Validates grant can execute specific graphId.
   * Per GRANT_SCOPES_CONSTRAIN_GRAPHS: checks scope includes graphId.
   * Back-compat wrapper: `requiredScope = graph:execute:<graphId>`. The M1
   * grant↔node binding for graph scopes is enforced by the worker passing the
   * dispatched nodeId through `validateGrantForScope`.
   * @throws GrantNotFoundError, GrantExpiredError, GrantRevokedError, GrantScopeMismatchError, GrantNodeMismatchError
   */
  validateGrantForGraph: (
    actorId: ActorId,
    nodeId: string,
    grantId: string,
    graphId: string
  ) => Promise<ExecutionGrant>;
}
