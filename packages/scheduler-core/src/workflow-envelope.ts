// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/workflow-envelope`
 * Purpose: Canonical producer input for schedule writes and private diagnostic verification.
 * Scope: Pure envelope construction; does not perform SDK calls, I/O or ownership decisions.
 * Invariants: Existing producer semantics and key sets are preserved.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import type { JsonObject } from "type-fest";
import type { CreateScheduleParams } from "./ports/schedule-control.port";

/**
 * Build the workflow `args[0]` envelope for a schedule.
 *
 * Storage decision (no migration — design § Storage): for a NodeTask the
 * `{route, payload}` tunnel inside `input` and `graph_id` carries `task:<route>`.
 * This unwraps that into the `NodeTaskInput` the NodeTaskWorkflow expects; every
 * other workflowType keeps the canonical GraphRunWorkflowInput shape (CollectEpoch
 * etc. ignore graph fields and read `input`).
 */
export function buildWorkflowArgs(
  params: CreateScheduleParams,
  workflowType: string
): Record<string, unknown> {
  if (workflowType === "NodeTaskWorkflow") {
    const input =
      params.input && typeof params.input === "object"
        ? (params.input as Record<string, unknown>)
        : {};
    const route =
      typeof input.route === "string"
        ? input.route
        : // Fallback: derive from the `task:<route>` graphId tunnel.
          params.graphId.startsWith("task:")
          ? params.graphId.slice("task:".length)
          : params.graphId;
    const payload =
      input.payload && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>)
        : {};
    return {
      nodeId: params.nodeId,
      route,
      payload,
      executionGrantId: params.executionGrantId,
      runKind: "system_scheduled" as const,
      triggerSource: "temporal_schedule",
      scheduleId: params.scheduleId,
      requestedBy: params.ownerUserId,
    };
  }

  // Default: the unified GraphRunWorkflowInput shape.
  return {
    nodeId: params.nodeId,
    graphId: params.graphId,
    executionGrantId: params.executionGrantId,
    input: params.input,
    runKind: "system_scheduled" as const,
    triggerSource: "temporal_schedule",
    triggerRef: params.scheduleId,
    requestedBy: params.ownerUserId,
    dbScheduleId: params.dbScheduleId ?? null,
    temporalScheduleId: params.scheduleId,
  };
}

/** Same ledger input for the authoritative writer and its read-only verifier. */
export function buildLedgerIngestInput(
  ledger: NonNullable<
    import("./services/syncGovernanceSchedules").GovernanceScheduleConfig["ledger"]
  >
): JsonObject {
  const input: JsonObject = {
    version: 1,
    scopeId: ledger.scopeId,
    scopeKey: ledger.scopeKey,
    epochLengthDays: ledger.epochLengthDays,
    activitySources: ledger.activitySources,
  };
  if (ledger.baseIssuanceCredits)
    input.baseIssuanceCredits = ledger.baseIssuanceCredits;
  if (ledger.approvers && ledger.approvers.length > 0)
    input.approvers = ledger.approvers;
  return input;
}
