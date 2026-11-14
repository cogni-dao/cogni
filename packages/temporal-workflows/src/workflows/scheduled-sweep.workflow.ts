// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/scheduled-sweep`
 * Purpose: Reusable Temporal workflow for queue-sweeping agent roles.
 * Scope: Deterministic orchestration only. Does not perform I/O directly — all I/O delegated to activities.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O in workflow code
 *   - ONE_WORKFLOW_ALL_ROLES: parameterized by roleId/graphId/queueFilter
 *   - REUSE_GRAPH_RUN_WORKFLOW: delegates to GraphRunWorkflow via executeChild
 *   - Short-lived per tick (~10 events, well under Temporal history limits)
 * Side-effects: none (deterministic orchestration only)
 * Links: https://cognidao.org/knowledge/temporal-workflow-rules
 * @public
 */

import { executeChild, proxyActivities, uuid4 } from "@temporalio/workflow";
import { STANDARD_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { SweepActivities } from "../activity-types.js";
import type { GraphRunResult } from "./graph-run.workflow.js";

const { fetchWorkItemsActivity, processSweepResultActivity } =
  proxyActivities<SweepActivities>(STANDARD_ACTIVITY_OPTIONS);

/**
 * Input for ScheduledSweepWorkflow.
 * Populated from RoleSpec at schedule creation time.
 */
export interface ScheduledSweepInput {
  roleId: string;
  graphId: string;
  model: string;
  queueFilter: {
    statuses?: string[];
    labels?: string[];
    types?: string[];
  };
  /** System billing account ID (resolved at schedule creation) */
  billingAccountId: string;
  /** System virtual key ID */
  virtualKeyId: string;
}

/**
 * Result from ScheduledSweepWorkflow.
 */
export interface ScheduledSweepResult {
  outcome: "success" | "error" | "no_op";
  roleId: string;
  itemId?: string;
  runId?: string;
}

/**
 * ScheduledSweepWorkflow — reusable agent heartbeat for queue-sweeping roles.
 *
 * Flow:
 * 1. Activity: fetch + filter work items from app API
 * 2. Workflow: pick highest-priority item (deterministic sort)
 * 3. Child: GraphRunWorkflow executes the role's graph with item context
 * 4. Activity: process result (log outcome, post to Discord)
 *
 * Idempotency: workflowId = sweep:{roleId}:{timeBucket}
 * One per tick, per OVERLAP_SKIP_DEFAULT.
 */
export async function ScheduledSweepWorkflow(
  input: ScheduledSweepInput
): Promise<ScheduledSweepResult> {
  const {
    roleId,
    graphId,
    model,
    queueFilter,
    billingAccountId,
    virtualKeyId,
  } = input;

  // Activity: fetch work items matching the role's filter
  const items = await fetchWorkItemsActivity({
    statuses: queueFilter.statuses,
    labels: queueFilter.labels,
    types: queueFilter.types,
  });

  if (items.length === 0) {
    return { outcome: "no_op", roleId };
  }

  // Workflow: deterministic pick — first item is highest priority (activity pre-sorted)
  const item = items[0];
  if (!item) return { outcome: "no_op", roleId };
  const runId = uuid4();

  // Child workflow: run the graph with item context
  let graphResult: GraphRunResult;
  try {
    graphResult = await executeChild("GraphRunWorkflow", {
      workflowId: `graph-run:system:${roleId}:${item.id}`,
      args: [
        {
          graphId,
          executionGrantId: null,
          input: {
            messages: [
              {
                role: "user",
                content: `Work item to process:\n\nID: ${item.id}\nTitle: ${item.title}\nStatus: ${item.status}\nPriority: ${item.priority ?? "unset"}\nSummary: ${item.summary ?? "none"}\n\nTake the appropriate action for this item based on your role.`,
              },
            ],
            model,
            actorUserId: "cogni_system",
            billingAccountId,
            virtualKeyId,
          },
          runKind: "system_scheduled" as const,
          triggerSource: `role:${roleId}`,
          triggerRef: `${roleId}:${item.id}`,
          requestedBy: "cogni_system",
          runId,
        },
      ],
    });
  } catch {
    graphResult = { ok: false, runId };
  }

  // Activity: log result + optional Discord post
  await processSweepResultActivity({
    roleId,
    itemId: item.id,
    itemTitle: item.title,
    outcome: graphResult.ok ? "success" : "error",
    runId,
  });

  return {
    outcome: graphResult.ok ? "success" : "error",
    roleId,
    itemId: item.id,
    runId,
  };
}
