// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/node-task.schema`
 * Purpose: Zod schema for `NodeTaskInput` — the single source of truth for the generic NodeTaskWorkflow's input shape.
 * Scope: Schema definition + `z.infer<>` type export + the route/scope helpers that derive from it. Does not contain business logic, runtime I/O, or side-effects.
 * Invariants:
 *   - SINGLE_INPUT_CONTRACT: schema is the single source of truth (see Purpose); `.strict()` rejects typo'd / foreign fields.
 *   - DISPATCH_FAIL_FAST: producers (syncNodeSchedules / schedule-control) parse with this schema before `workflowClient.start(...)`.
 *   - ROUTE_RELATIVE_ONLY (M3/SSRF): `route` is a node-relative path (must start with "/", no scheme/host) — the dispatch activity binds it to the node's OWN resolved host. Absolute/foreign URLs reject at parse time.
 *   - SCOPE_IS_NODE_BOUND (M1+M2): grant scope for a node task is `task:dispatch:<nodeId>:<route>` — the nodeId is embedded so grant↔node binding is structural (the grants table has no node_id column; no migration). The scope is minted + checked in `@cogni/scheduler-core` `scopes.ts` (single source); validation rejects a grant whose embedded nodeId ≠ the dispatched nodeId.
 * Side-effects: none
 * Links: docs/design/node-temporal-tenant-interface.md (story.5008, task.5029), docs/spec/temporal-patterns.md (SINGLE_INPUT_CONTRACT), pr-review.schema.ts (reference)
 * @public
 */

import { z } from "zod";

/**
 * A node-relative route: must start with a single "/", must NOT contain a
 * scheme (`http://`) or a protocol-relative prefix (`//`). The dispatch
 * activity prepends the node's OWN resolved `nodeUrl` host — so an absolute or
 * foreign URL here would let a schedule POST cross-tenant (SSRF). Rejecting at
 * parse time (ROUTE_RELATIVE_ONLY) is the M3 security close.
 */
export const NodeRouteSchema = z
  .string()
  .min(1)
  .refine((r) => r.startsWith("/") && !r.startsWith("//"), {
    message: "route must be a node-relative path starting with a single '/'",
  })
  .refine((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r), {
    message: "route must not contain a URL scheme (relative path only)",
  })
  .refine((r) => !r.includes(".."), {
    message: "route must not contain '..' path traversal",
  });

/**
 * Workflow input contract for the generic `NodeTaskWorkflow`.
 *
 * Source-of-truth Zod schema. The producer (T3's `syncNodeSchedules` →
 * `schedule-control.adapter`) and the consumer (`NodeTaskWorkflow` +
 * `dispatchNodeTaskActivity` in `services/scheduler-worker`) both consume the
 * inferred type via `z.infer<typeof NodeTaskInputSchema>`.
 *
 * Storage decision (no migration — see design § Storage): the schedule row's
 * `graph_id` carries `task:<route>` to satisfy the NOT NULL constraint, and
 * `{route, payload}` tunnel inside the `input` envelope. This schema describes
 * that `input` envelope after the schedule-control adapter unwraps it into the
 * workflow args.
 */
export const NodeTaskInputSchema = z
  .object({
    /** Originating node ID from repo-spec (UUID). Routes the dispatch + binds the grant scope. */
    nodeId: z.string().uuid(),
    /** Node-relative route the dispatch activity POSTs (ROUTE_RELATIVE_ONLY). */
    route: NodeRouteSchema,
    /** Opaque payload forwarded to the node's route. The node's route owns its meaning. */
    payload: z.record(z.unknown()),
    /**
     * Execution grant ID authorizing this dispatch. Required for scheduled node
     * tasks (unlike graphs, there is no API-triggered NodeTask path that skips
     * the grant — every NodeTask is a scheduled, system-principal dispatch).
     */
    executionGrantId: z.string().uuid(),
    /** How the run was triggered. NodeTasks are always scheduled in MVP. */
    runKind: z.literal("system_scheduled"),
    /** Trigger source identifier (always "temporal_schedule" for NodeTasks). */
    triggerSource: z.string().min(1),
    /** Upstream Temporal schedule ID for provenance + idempotency keying. */
    scheduleId: z.string().min(1),
    /** User ID (UUID) who owns the schedule — the system principal in MVP. */
    requestedBy: z.string().min(1),
  })
  .strict();
// .strict(): a renamed/typo'd field (e.g. `payLoad`, `node_id`) rejects at
// parse time rather than silently passing a malformed object over Temporal's
// wire — the regression class SINGLE_INPUT_CONTRACT exists to close.

/**
 * Inferred TS type for `NodeTaskWorkflow`'s input.
 * Per SINGLE_INPUT_CONTRACT: never duplicate this shape as a separate interface.
 *
 * Note on the grant scope: the node-bound scope string
 * (`task:dispatch:<nodeId>:<route>`, the M1 grant↔node binding) is minted +
 * checked exclusively in `@cogni/scheduler-core` (`scopes.ts`) — the worker
 * activity derives it there before HTTP-validating. The deterministic workflow
 * never hand-formats a scope; it forwards `nodeId` + `route` to the activity.
 */
export type NodeTaskInput = z.infer<typeof NodeTaskInputSchema>;
