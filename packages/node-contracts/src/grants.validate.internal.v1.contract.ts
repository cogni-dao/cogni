// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/grants.validate.internal.v1.contract`
 * Purpose: Contract for validating an execution grant against a scoped action (scheduler-worker → node app).
 * Scope: Wire format for POST /api/internal/grants/{grantId}/validate. Does not implement the route or hold business logic.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN required
 *   - 403 on invalid/expired/revoked/scope-mismatch/node-mismatch with machine-readable `error` code
 *   - GRANT_NODE_BINDING (M1, task.5029): the body carries `nodeId` (the node the worker dispatches for); the route asserts it matches its OWN getNodeId() AND passes it to validateGrantForScope so a leaked grantId cannot cross tenants.
 *   - SCOPE_GENERALIZED (M2, task.5029): `scope` is the required scope string ("graph:execute:<id>" or "task:dispatch:<nodeId>:<route>"). `graphId` retained (optional) for back-compat callers that haven't migrated; the route derives `scope` from `graphId` when `scope` is absent.
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: /api/internal/grants/[grantId]/validate route, docs/spec/scheduler.md, task.0280, task.5029
 * @internal
 */

import { z } from "zod";

export const InternalValidateGrantInputSchema = z
  .object({
    /** Node the worker is dispatching for (M1 grant↔node binding). Optional for back-compat; recommended for all callers. */
    nodeId: z.string().optional(),
    /** Generalized required scope (M2). When absent, the route derives it from `graphId`. */
    scope: z.string().optional(),
    /** Graph ID — back-compat. At least one of `scope` or `graphId` must be present. */
    graphId: z.string().optional(),
  })
  .refine((b) => b.scope !== undefined || b.graphId !== undefined, {
    message: "one of `scope` or `graphId` is required",
  });

export const InternalValidateGrantOutputSchema = z.object({
  ok: z.literal(true),
  grant: z.object({
    id: z.string(),
    userId: z.string(),
    billingAccountId: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  }),
});

export const GrantValidationErrorCode = z.enum([
  "grant_not_found",
  "grant_expired",
  "grant_revoked",
  "grant_scope_mismatch",
  // M1 (task.5029): grant is not bound to the dispatched node.
  "grant_node_mismatch",
]);

export const InternalValidateGrantErrorSchema = z.object({
  ok: z.literal(false),
  error: GrantValidationErrorCode,
});

export const internalValidateGrantOperation = {
  id: "grants.validate.internal.v1",
  summary:
    "Validate execution grant for a scoped action (scheduler-worker → node app)",
  description:
    "Internal endpoint called by scheduler-worker to validate a grant before a scoped dispatch (graph execution or node-task http-dispatch). Asserts grant↔node binding (M1) + the required scope (M2). Node owns grants table; worker owns no DB credentials.",
  input: InternalValidateGrantInputSchema,
  output: InternalValidateGrantOutputSchema,
} as const;

export type InternalValidateGrantInput = z.infer<
  typeof InternalValidateGrantInputSchema
>;
export type InternalValidateGrantOutput = z.infer<
  typeof InternalValidateGrantOutputSchema
>;
export type InternalValidateGrantError = z.infer<
  typeof InternalValidateGrantErrorSchema
>;
