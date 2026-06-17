// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/run-http`
 * Purpose: HTTP-backed implementations of GraphRunRepository + ExecutionGrantWorkerPort used by worker activities.
 * Scope: Worker owns no DB credentials for runs/grants. These adapters route each call to the owning node's internal API based on nodeId → nodeUrl lookup.
 * Invariants:
 *   - NO_DB_IN_WORKER: No DB client created here. Only fetch().
 *   - nodeId is mandatory and resolved against COGNI_NODE_ENDPOINTS at call time.
 *   - Bearer SCHEDULER_API_TOKEN attached to every request.
 *   - 4xx responses are mapped to port-level errors (grant errors); 5xx/network errors rethrow so Temporal retries.
 * Side-effects: IO (HTTP)
 * Links: task.0280, packages/node-contracts/src/graph-runs.*.internal.v1.contract.ts, packages/node-contracts/src/grants.validate.internal.v1.contract.ts
 * @internal
 */

import type {
  InternalCreateGraphRunInput,
  InternalUpdateGraphRunInput,
  InternalValidateGrantError,
  InternalValidateGrantOutput,
} from "@cogni/node-contracts";
import { graphExecuteScope } from "@cogni/scheduler-core";
import type { Logger } from "../observability/logger.js";
import {
  type ExecutionGrantHttpValidator,
  GrantExpiredError,
  GrantNodeMismatchError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
  type GraphRunHttpWriter,
  RunHttpClientError,
} from "../ports/index.js";

// Re-export for any direct consumer — port module is the source of truth.
export {
  GrantExpiredError,
  GrantNodeMismatchError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
  RunHttpClientError,
};

export interface RunHttpAdapterDeps {
  nodeEndpoints: Map<string, string>;
  schedulerApiToken: string;
  logger: Logger;
}

function resolveNodeUrl(
  nodeEndpoints: Map<string, string>,
  nodeId: string
): string {
  const url = nodeEndpoints.get(nodeId);
  if (!url) {
    throw new RunHttpClientError(
      `Unknown nodeId "${nodeId}" — not in COGNI_NODE_ENDPOINTS`,
      0,
      false
    );
  }
  return url.replace(/\/$/, "");
}

function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function readErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable>";
  }
}

/**
 * HTTP status codes that are retryable — the request may succeed on a later
 * attempt. Everything else (permanent 4xx: 400 bad request, 401 auth, 403
 * forbidden, 422 validation) stays non-retryable so Temporal stops retrying
 * a request that is structurally invalid.
 *
 *   404 / 408 / 409 / 429 → retryable:
 *     - 404 covers the deploy-time race where the new worker rolls before
 *       node-app catches up with the new `/api/internal/graph-runs` routes.
 *     - 408 / 429 are transient by definition.
 *     - 409 covers temporary idempotency-in-progress responses.
 *   5xx / network errors → retryable.
 */
const RETRYABLE_TRANSIENT_4XX = new Set([404, 408, 409, 429]);
function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return RETRYABLE_TRANSIENT_4XX.has(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer: createRun / markRunStarted / markRunCompleted
// ─────────────────────────────────────────────────────────────────────────────

export function createHttpGraphRunWriter(
  deps: RunHttpAdapterDeps
): GraphRunHttpWriter {
  const { nodeEndpoints, schedulerApiToken, logger } = deps;

  async function postCreate(
    nodeId: string,
    body: InternalCreateGraphRunInput
  ): Promise<void> {
    const base = resolveNodeUrl(nodeEndpoints, nodeId);
    const url = `${base}/api/internal/graph-runs`;
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(schedulerApiToken),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await readErrorText(response);
      const retryable = isRetryableStatus(response.status);
      logger.error(
        {
          nodeId,
          url,
          status: response.status,
          errorText,
          retryable,
          runId: body.runId,
        },
        "graph-runs.create.internal failed"
      );
      throw new RunHttpClientError(
        `POST ${url} -> ${response.status}: ${errorText}`,
        response.status,
        retryable
      );
    }
  }

  async function patchUpdate(
    nodeId: string,
    runId: string,
    body: InternalUpdateGraphRunInput
  ): Promise<void> {
    const base = resolveNodeUrl(nodeEndpoints, nodeId);
    const url = `${base}/api/internal/graph-runs/${encodeURIComponent(runId)}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: authHeaders(schedulerApiToken),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await readErrorText(response);
      const retryable = isRetryableStatus(response.status);
      logger.error(
        { nodeId, url, status: response.status, errorText, retryable, runId },
        "graph-runs.update.internal failed"
      );
      throw new RunHttpClientError(
        `PATCH ${url} -> ${response.status}: ${errorText}`,
        response.status,
        retryable
      );
    }
  }

  return {
    async createRun(_actorId, nodeId, params) {
      await postCreate(nodeId, {
        runId: params.runId,
        ...(params.graphId !== undefined && { graphId: params.graphId }),
        ...(params.runKind !== undefined && {
          runKind: params.runKind as InternalCreateGraphRunInput["runKind"],
        }),
        ...(params.triggerSource !== undefined && {
          triggerSource: params.triggerSource,
        }),
        ...(params.triggerRef !== undefined && {
          triggerRef: params.triggerRef,
        }),
        ...(params.requestedBy !== undefined && {
          requestedBy: params.requestedBy,
        }),
        ...(params.scheduleId !== undefined && {
          scheduleId: params.scheduleId,
        }),
        ...(params.scheduledFor !== undefined && {
          scheduledFor: params.scheduledFor.toISOString(),
        }),
        ...(params.stateKey !== undefined && { stateKey: params.stateKey }),
      });
    },

    async markRunStarted(_actorId, nodeId, runId, traceId) {
      await patchUpdate(nodeId, runId, {
        status: "running",
        ...(traceId !== undefined && { traceId }),
      });
    },

    async markRunCompleted(
      _actorId,
      nodeId,
      runId,
      status,
      errorMessage,
      errorCode
    ) {
      await patchUpdate(nodeId, runId, {
        status,
        ...(errorMessage !== undefined && { errorMessage }),
        ...(errorCode !== undefined && { errorCode }),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant validator
// ─────────────────────────────────────────────────────────────────────────────

export function createHttpExecutionGrantValidator(
  deps: RunHttpAdapterDeps
): ExecutionGrantHttpValidator {
  const { nodeEndpoints, schedulerApiToken, logger } = deps;

  async function validateGrantForScope(
    _actorId: Parameters<
      ExecutionGrantHttpValidator["validateGrantForScope"]
    >[0],
    nodeId: string,
    grantId: string,
    scope: string
  ) {
    const base = resolveNodeUrl(nodeEndpoints, nodeId);
    const url = `${base}/api/internal/grants/${encodeURIComponent(grantId)}/validate`;
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(schedulerApiToken),
      // M1: send the dispatched nodeId so the node asserts the grant↔node
      // binding; M2: send the generalized scope (graph + task share one path).
      body: JSON.stringify({ nodeId, scope }),
    });

    if (response.status === 403) {
      const body = (await response
        .json()
        .catch(() => null)) as InternalValidateGrantError | null;
      const code = body?.error;
      if (code === "grant_not_found") throw new GrantNotFoundError(grantId);
      if (code === "grant_expired") throw new GrantExpiredError(grantId);
      if (code === "grant_revoked") throw new GrantRevokedError(grantId);
      if (code === "grant_node_mismatch")
        throw new GrantNodeMismatchError(grantId, nodeId);
      if (code === "grant_scope_mismatch")
        throw new GrantScopeMismatchError(grantId, scope);
      throw new GrantNotFoundError(grantId);
    }

    if (!response.ok) {
      const errorText = await readErrorText(response);
      const retryable = isRetryableStatus(response.status);
      logger.error(
        {
          nodeId,
          url,
          status: response.status,
          errorText,
          retryable,
          grantId,
          scope,
        },
        "grants.validate.internal failed"
      );
      throw new RunHttpClientError(
        `POST ${url} -> ${response.status}: ${errorText}`,
        response.status,
        retryable
      );
    }

    const body = (await response.json()) as InternalValidateGrantOutput;
    return {
      id: body.grant.id,
      userId: body.grant.userId,
      billingAccountId: body.grant.billingAccountId,
      scopes: body.grant.scopes,
      expiresAt: body.grant.expiresAt ? new Date(body.grant.expiresAt) : null,
      revokedAt: body.grant.revokedAt ? new Date(body.grant.revokedAt) : null,
      createdAt: new Date(body.grant.createdAt),
    };
  }

  return {
    validateGrantForScope,
    async validateGrantForGraph(actorId, nodeId, grantId, graphId) {
      return validateGrantForScope(
        actorId,
        nodeId,
        grantId,
        graphExecuteScope(graphId)
      );
    },
  };
}
