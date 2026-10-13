// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/graph-run`
 * Purpose: Unified Temporal Workflow for all graph execution (scheduled, API, webhook).
 * Scope: Deterministic orchestration only. Does not perform I/O — all external calls happen in Activities.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O, network calls, or LLM calls in workflow code
 *   - Per SINGLE_RUN_LEDGER: always creates graph_runs record (no dbScheduleId gate)
 *   - Per EXECUTION_VIA_SERVICE_API: executeGraphActivity calls internal API, not GraphExecutorPort
 *   - Per IDEMPOTENT_RUN_START: Workflow ID = graph-run:{billingAccountId}:{idempotencyKey}
 *   - CALLER_PROVIDED_RUN_ID: accepts optional runId from caller for cross-system correlation (falls back to uuid4)
 *   - CONDITIONAL_GRANT_VALIDATION: skips validateGrantActivity when executionGrantId is null (API-triggered runs)
 *   - CONVERGED_FINALIZE: all terminal paths go through updateGraphRunActivity
 *   - TRANSPORT_UNCERTAINTY_NOT_TERMINAL: exhausted retryable transport failures never overwrite a node execution that may still finish
 *   - TYPED_TERMINAL_ARTIFACT: returns small typed result {ok, runId, structuredOutput} for parent workflow composition
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/spec/unified-graph-launch.md, docs/spec/temporal-patterns.md
 * @public
 */

import {
  ActivityFailure,
  ApplicationFailure,
  patched,
  proxyActivities,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import { GRAPH_EXECUTION_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { SchedulerActivities } from "../activity-types.js";

/**
 * Terminal artifact returned by GraphRunWorkflow.
 * Small typed result for parent workflow composition — NOT raw stream/transcript data.
 * Redis/SSE remain the observability transport.
 */
export interface GraphRunResult {
  ok: boolean;
  runId: string;
  /** Structured output from graph (when responseFormat was provided). */
  structuredOutput?: unknown;
}

// Short timeout for metadata activities (grant validation, run record CRUD).
// Per task.0280: these activities HTTP-call the owning node. Retry budget
// must cover a rollout window where the new worker rolls ahead of the
// target node-app (→ 404 on new internal routes). 6 attempts × max 30s
// backoff = up to ~2 minutes of tolerance, which comfortably absorbs an
// Argo parallel rollout window for a single node.
const {
  validateGrantActivity,
  createGraphRunActivity,
  updateGraphRunActivity,
} = proxyActivities<SchedulerActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 6,
  },
});

// New executions use durable transport recovery. The receiver has a proven
// execution_requests dedup contract, so every attempt carries the same command
// identity and only reconciles the existing execution.
const { executeGraphActivity: executeGraphActivityWithRecovery } =
  proxyActivities<SchedulerActivities>(GRAPH_EXECUTION_ACTIVITY_OPTIONS);

// Replay compatibility for histories created before bug.5447. The patch gate
// below keeps their already-scheduled Activity command byte-for-byte stable.
const { executeGraphActivity: executeGraphActivityLegacy } =
  proxyActivities<SchedulerActivities>({
    startToCloseTimeout: "15 minutes",
    retry: { maximumAttempts: 1 },
  });

const GRAPH_TRANSPORT_RECOVERY_PATCH = "bug.5447-graph-transport-recovery-v1";

/** @internal Transport exhaustion is not a graph outcome and must not write a terminal. */
export function isDefinitiveGraphActivityFailure(error: unknown): boolean {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  return cause instanceof ApplicationFailure && cause.nonRetryable === true;
}

/**
 * Input for GraphRunWorkflow.
 * Supports all trigger types via trigger provenance fields.
 */
export interface GraphRunWorkflowInput {
  /** Originating node ID from repo-spec. Routes execution to correct node. */
  nodeId: string;
  /** Graph ID to execute (format: provider:name, e.g. "langgraph:poet") */
  graphId: string;
  /** Execution grant ID for authorization (scheduled/webhook). Null for API-triggered runs. */
  executionGrantId?: string | null;
  /** Graph input payload */
  input: Record<string, unknown>;
  /** How the run was triggered */
  runKind: "user_immediate" | "system_scheduled" | "system_webhook";
  /** Trigger source identifier (api, temporal_schedule, webhook:{type}) */
  triggerSource: string;
  /** Upstream delivery/schedule ID for provenance */
  triggerRef: string;
  /** User ID or 'cogni_system' who requested the run */
  requestedBy: string;
  /** DB schedule UUID — only for scheduled runs */
  dbScheduleId?: string | null;
  /** Temporal schedule ID — only for scheduled runs */
  temporalScheduleId?: string;
  /** Intended execution time — only for scheduled runs (ISO string) */
  scheduledFor?: string;
  /** Optional caller-provided run ID for cross-system correlation */
  runId?: string;
}

/**
 * GraphRunWorkflow — Unified orchestration for all graph execution.
 *
 * Flow:
 * 1. Validate grant (fail-fast → skipped)
 * 2. Create graph_runs record (ALWAYS — per SINGLE_RUN_LEDGER)
 * 3. Mark run as started
 * 4. Execute graph via internal API
 * 5. CONVERGED_FINALIZE: mark run as success/error
 *
 * All terminal paths converge through updateGraphRunActivity.
 */
export async function GraphRunWorkflow(
  input: GraphRunWorkflowInput
): Promise<GraphRunResult> {
  const {
    nodeId,
    graphId,
    executionGrantId,
    input: graphInput,
    runKind,
    triggerSource,
    triggerRef,
    requestedBy,
    dbScheduleId,
    temporalScheduleId,
    scheduledFor: inputScheduledFor,
    runId: providedRunId,
  } = input;

  // For scheduled runs, derive scheduledFor from Temporal search attribute.
  // For non-scheduled runs, use input value or skip.
  let scheduledFor = inputScheduledFor;
  if (runKind === "system_scheduled" && !scheduledFor) {
    const info = workflowInfo();
    const scheduledStartTime = info.searchAttributes
      ?.TemporalScheduledStartTime as Date[] | undefined;
    if (scheduledStartTime?.[0]) {
      scheduledFor = scheduledStartTime[0].toISOString();
    }
  }

  // Generate run ID if caller did not provide one.
  const runId = providedRunId ?? uuid4();

  // Extract stateKey from graph input for thread↔run correlation.
  // Per STATEKEY_NULLABLE: may be absent for headless/webhook runs.
  const stateKey: string | undefined =
    typeof graphInput?.stateKey === "string" && graphInput.stateKey.length > 0
      ? graphInput.stateKey
      : undefined;

  // Note: idempotency key is derived inside executeGraphActivity as
  // `${temporalScheduleId}:${scheduledFor}` per SLOT_IDEMPOTENCY_VIA_EXECUTION_REQUESTS.

  // 1. Validate grant for non-API runs (fail-fast).
  // API-triggered runs skip grant validation; billing/preflight decorators enforce auth/credits.
  if (executionGrantId) {
    try {
      await validateGrantActivity({
        nodeId,
        grantId: executionGrantId,
        graphId,
      });
    } catch {
      // Grant invalid — create record and mark skipped (CONVERGED_FINALIZE)
      await createGraphRunActivity({
        nodeId,
        runId,
        graphId,
        runKind,
        triggerSource,
        triggerRef,
        requestedBy,
        dbScheduleId: dbScheduleId ?? undefined,
        scheduledFor,
        stateKey,
      });
      await updateGraphRunActivity({
        nodeId,
        runId,
        status: "skipped",
        errorMessage: "Grant validation failed",
      });
      return { ok: false, runId };
    }
  }

  // 2. Create graph_runs record — ALWAYS (per SINGLE_RUN_LEDGER, no dbScheduleId gate)
  await createGraphRunActivity({
    nodeId,
    runId,
    graphId,
    runKind,
    triggerSource,
    triggerRef,
    requestedBy,
    dbScheduleId: dbScheduleId ?? undefined,
    scheduledFor,
    stateKey,
  });

  // 3. Mark run as started
  await updateGraphRunActivity({ nodeId, runId, status: "running" });

  // 4. Execute graph via internal API. patched() preserves replay for runs
  // whose Activity command was created before transport recovery shipped.
  const transportRecoveryEnabled = patched(GRAPH_TRANSPORT_RECOVERY_PATCH);
  const executeGraphActivity = transportRecoveryEnabled
    ? executeGraphActivityWithRecovery
    : executeGraphActivityLegacy;
  try {
    const result = await executeGraphActivity({
      nodeId,
      temporalScheduleId,
      graphId,
      executionGrantId: executionGrantId ?? null,
      input: graphInput,
      scheduledFor: scheduledFor ?? workflowInfo().startTime.toISOString(),
      runId,
    });

    // 5. CONVERGED_FINALIZE: mark success or error
    if (result.ok) {
      await updateGraphRunActivity({
        nodeId,
        runId,
        status: "success",
        traceId: result.traceId,
      });
      return {
        ok: true,
        runId,
        ...(result.structuredOutput !== undefined && {
          structuredOutput: result.structuredOutput,
        }),
      };
    } else {
      await updateGraphRunActivity({
        nodeId,
        runId,
        status: "error",
        traceId: result.traceId,
        errorMessage: result.errorCode ?? "Graph execution failed",
        errorCode: result.errorCode,
      });
      return { ok: false, runId };
    }
  } catch (error) {
    // A non-retryable Activity failure is a definitive pre-execution rejection
    // (auth, validation, idempotency mismatch, or unknown node). A retryable
    // failure exhausted by scheduleToClose is transport-unknown: the node may
    // still finish, so writing graph_runs=error would recreate the split brain.
    if (!transportRecoveryEnabled || isDefinitiveGraphActivityFailure(error)) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during execution";
      await updateGraphRunActivity({
        nodeId,
        runId,
        status: "error",
        errorMessage,
      });
    }
    throw error; // Re-throw so Temporal marks workflow as failed
  }
}
