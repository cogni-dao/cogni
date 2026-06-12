// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/goal-loop`
 * Purpose: Temporal Activities for the AI goal + KPI loop. Each is a thin
 *   HTTP-delegation to the owning node's `/api/internal/goal-loop` route — the
 *   worker holds no DB creds (SHARED_COMPUTE_HOLDS_NO_DB_CREDS), exactly like
 *   the graph-run + review activity paths.
 * Scope: I/O delegation only. The pure loop control + halt predicate live in the
 *   `GoalLoopWorkflow` + `@cogni/knowledge-store/goal-loop`; the EDO writes +
 *   KPI read live behind the operator route.
 * Invariants:
 *   - Per EXECUTION_VIA_SERVICE_API: never imports knowledge-store DB code; every
 *     op routes to the operator via fetch + Bearer SCHEDULER_API_TOKEN.
 *   - Per ACTIVITY_IDEMPOTENCY: `runStepActivity` passes the stable business key
 *     `${hypothesisId}/${iteration}`; `fileGoalOutcomeActivity` is keyed on
 *     `${hypothesisId}` server-side — retries are no-ops.
 *   - Per KPI_VERIFIER_INDEPENDENT: `readKpiActivity` resolves the
 *     verifier-independent `metric:judge` reader server-side.
 *   - 4xx → non-retryable ApplicationFailure; 5xx/network → bubble for Temporal retry.
 * Side-effects: IO (HTTP to operator goal-loop plane)
 * Links: docs/design/knowledge-goal-loop.md § Pareto MVP, packages/temporal-workflows/src/activity-types.ts
 * @internal
 */

import type { GoalLoopActivities } from "@cogni/temporal-workflows";
import { ApplicationFailure } from "@temporalio/activity";
import type { Logger } from "../observability/logger.js";

export interface GoalLoopActivityDeps {
  nodeEndpoints: Map<string, string>;
  schedulerApiToken: string;
  logger: Logger;
}

function resolveNodeUrl(deps: GoalLoopActivityDeps, nodeId: string): string {
  const url = deps.nodeEndpoints.get(nodeId);
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      `Unknown nodeId "${nodeId}" — not in COGNI_NODE_ENDPOINTS`,
      "UNKNOWN_NODE"
    );
  }
  return url.replace(/\/$/, "");
}

async function postOp(
  deps: GoalLoopActivityDeps,
  nodeId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const base = resolveNodeUrl(deps, nodeId);
  const url = `${base}/api/internal/goal-loop`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.schedulerApiToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    deps.logger.error(
      { nodeId, url, status: response.status, op: body.op, text },
      "goal-loop.internal op failed"
    );
    // 4xx is non-retryable (bad request / not-a-goal); 5xx bubbles for retry.
    if (response.status >= 400 && response.status < 500) {
      throw ApplicationFailure.nonRetryable(
        `goal-loop op '${String(body.op)}' -> ${response.status}: ${text}`,
        "GoalLoopClientError",
        { status: response.status }
      );
    }
    throw new Error(
      `goal-loop op '${String(body.op)}' -> ${response.status}: ${text}`
    );
  }
  return response.json();
}

export function createGoalLoopActivities(
  deps: GoalLoopActivityDeps
): GoalLoopActivities {
  return {
    async loadGoalActivity({ nodeId, hypothesisId }) {
      const res = (await postOp(deps, nodeId, {
        op: "load",
        hypothesisId,
      })) as {
        goal: {
          hypothesisId: string;
          domain: string;
          kpiId: string;
          target: number;
          evaluateAt: string;
        } | null;
        budget?: {
          maxIterations: number;
          maxTokens: number;
          maxRecursionDepth: number;
          maxStalledIterations: number;
        };
        stepGraphId?: string | null;
        nowIso?: string;
      };
      if (res.goal === null || !res.budget || !res.nowIso) {
        return null;
      }
      return {
        goal: res.goal,
        budget: res.budget,
        stepGraphId: res.stepGraphId ?? null,
        nowIso: res.nowIso,
      };
    },

    async readKpiActivity({ nodeId, hypothesisId }) {
      const res = (await postOp(deps, nodeId, {
        op: "read-kpi",
        hypothesisId,
      })) as { kpi: number };
      return res.kpi;
    },

    async runStepActivity({
      nodeId,
      hypothesisId,
      domain,
      idempotencyKey,
      iteration,
      stepGraphId,
    }) {
      const res = (await postOp(deps, nodeId, {
        op: "step",
        hypothesisId,
        domain,
        idempotencyKey,
        iteration,
        stepGraphId,
      })) as { ok: boolean; atomId: string; tokensSpent: number };
      return res;
    },

    async fileGoalOutcomeActivity({
      nodeId,
      hypothesisId,
      domain,
      edge,
      reason,
      lastKpi,
      target,
    }) {
      await postOp(deps, nodeId, {
        op: "outcome",
        hypothesisId,
        domain,
        edge,
        reason,
        lastKpi,
        target,
      });
    },
  };
}
