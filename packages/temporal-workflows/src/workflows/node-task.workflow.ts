// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/node-task`
 * Purpose: Generic non-graph Temporal Workflow — runs a node's declared recurring HTTP task under that node's tenant grant + principal.
 * Scope: Deterministic orchestration only. Does not perform I/O — grant validation + the node HTTP POST live in Activities.
 * Invariants:
 *   - TEMPORAL_DETERMINISM: no I/O / network / clock reads in workflow code; all external calls in Activities.
 *   - SCHEDULED_TIME_FROM_TEMPORAL: `scheduledFor` derives from the `TemporalScheduledStartTime` search attribute, never from input or wall clock (mirrors graph-run.workflow.ts).
 *   - GRANT_VALIDATED (G2/M1/M2): validate the grant for the node-bound scope `task:dispatch:<nodeId>:<route>` BEFORE dispatch — net-new on a non-graph workflow.
 *   - ROUTE_OWN_HOST (M3): the route is forwarded to the dispatch activity which binds it to the node's OWN resolved host (SSRF close lives in the activity + the schema's relative-path guard).
 *   - ACTIVITY_IDEMPOTENCY: dispatch forwards `Idempotency-Key: ${nodeId}/${scheduleId}/${scheduledFor}`; the node route MUST dedup on it. Retry profile = maximumAttempts:1 (MVP) until the dedup contract is proven.
 *   - GENERIC_NON_GRAPH: this is the one generic non-graph workflow for ALL nodes (supersedes CollectEpoch's special status). No graph child — the node's route IS the work.
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/design/node-temporal-tenant-interface.md (story.5008, task.5029), docs/spec/temporal-patterns.md
 * @public
 */

import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import { GRAPH_EXECUTION_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { SchedulerActivities } from "../activity-types.js";
import type { NodeTaskInput } from "./node-task.schema.js";

/** Terminal artifact returned by NodeTaskWorkflow (small typed result for parent composition). */
export interface NodeTaskResult {
  ok: boolean;
  /** HTTP status the node route returned (when reached). */
  status?: number;
}

// Metadata activity (grant validation): short timeout, retry budget covers a
// rollout window where the worker rolls ahead of the target node-app. Mirrors
// graph-run.workflow.ts's metadata profile rationale (task.0280).
const { validateNodeGrantActivity } = proxyActivities<SchedulerActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 6,
  },
});

// Dispatch: mirror executeGraphActivity — 15-min timeout, maximumAttempts:1
// (MVP, idempotency-collision risk; a retry profile is gated on the node route's
// proven dedup contract per the design).
const { dispatchNodeTaskActivity } = proxyActivities<SchedulerActivities>(
  GRAPH_EXECUTION_ACTIVITY_OPTIONS
);

/**
 * NodeTaskWorkflow — generic recurring HTTP task for any node.
 *
 * Flow:
 * 1. Derive `scheduledFor` from the Temporal search attribute (SCHEDULED_TIME_FROM_TEMPORAL).
 * 2. Validate the grant for the node-bound scope (fail-fast → workflow fails; no run ledger for tasks in MVP).
 * 3. Dispatch: POST {nodeUrl}{route} with the per-node principal + Idempotency-Key.
 */
export async function NodeTaskWorkflow(
  input: NodeTaskInput
): Promise<NodeTaskResult> {
  const { nodeId, route, payload, executionGrantId, scheduleId } = input;

  // 1. SCHEDULED_TIME_FROM_TEMPORAL — authoritative scheduled time.
  const info = workflowInfo();
  const scheduledStartTime = info.searchAttributes?.TemporalScheduledStartTime as
    | Date[]
    | undefined;
  const scheduledFor = scheduledStartTime?.[0]
    ? scheduledStartTime[0].toISOString()
    : // Fallback to the workflow start time for non-scheduled (manual trigger)
      // invocations; scheduled runs always have the search attribute.
      info.startTime.toISOString();

  // 2. GRANT_VALIDATED (net-new on a non-graph workflow) — node-bound scope.
  //    A failure here is non-retryable (grant state won't change) and fails the
  //    workflow; there is no NodeTask run ledger in MVP.
  await validateNodeGrantActivity({
    nodeId,
    grantId: executionGrantId,
    route,
  });

  // 3. Dispatch to the node's OWN route (the node's route IS the work).
  return dispatchNodeTaskActivity({
    nodeId,
    route,
    payload,
    scheduleId,
    scheduledFor,
  });
}
