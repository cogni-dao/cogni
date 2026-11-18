// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/run-http`
 * Purpose: HTTP-backed implementations of GraphRunRepository + ExecutionGrantWorkerPort used by worker activities.
 * Scope: Worker owns no DB credentials for runs/grants. These adapters route each call to the owning node's internal API based on nodeId → nodeUrl lookup.
 * Invariants:
 *   - NO_DB_IN_WORKER: No DB client created here. Only fetch().
 *   - nodeId is mandatory and resolved against COGNI_NODE_ENDPOINTS at call time. An optional `instance`
 *     other than `main` resolves from the operator instance directory instead (story.5159); an unresolvable
 *     instance is a non-retryable refusal before any request, never a fallback to the main copy.
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
  InstanceUnresolvedError,
  type InstanceUrlResolver,
  isMainInstance,
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
  /**
   * Resolves a NON-MAIN instance from the operator directory (story.5159). Absent = this worker has no
   * directory, so any non-main instance is refused. `main` never uses it.
   */
  instanceResolver?: InstanceUrlResolver | undefined;
}

function resolveNodeUrl(
  nodeEndpoints: Map<string, string>,
  nodeId: string
): string {
  const url = nodeEndpoints.get(nodeId);
  if (!url) {
    throw new RunHttpClientError(
      `Unknown nodeId "${nodeId}" — not in COGNI_NODE_ENDPOINTS (known: ${[...nodeEndpoints.keys()].join(", ")})`,
      0,
      false
    );
  }
  return url.replace(/\/$/, "");
}

/**
 * The base URL a call goes to. No instance or `main`: the COGNI_NODE_ENDPOINTS map, exactly as before.
 * Any other instance: the directory only. An unresolvable instance throws a NON-retryable
 * `RunHttpClientError` (retryable only when the operator was unreachable and nothing is cached) BEFORE any
 * request, so no token is sent and the call never falls back to the main copy.
 */
async function resolveBase(
  deps: RunHttpAdapterDeps,
  nodeId: string,
  instance: string | undefined
): Promise<string> {
  if (instance === undefined || isMainInstance(instance))
    return resolveNodeUrl(deps.nodeEndpoints, nodeId);
  if (!deps.instanceResolver)
    throw new RunHttpClientError(
      `Instance "${instance}" of node "${nodeId}" cannot be resolved: this worker has no instance directory (OPERATOR_DIRECTORY_URL); no request was sent`,
      0,
      false
    );
  try {
    const url = await deps.instanceResolver.resolve(nodeId, instance);
    return url.replace(/\/$/, "");
  } catch (err) {
    if (err instanceof InstanceUnresolvedError)
      throw new RunHttpClientError(err.message, 0, err.retryable);
    throw err;
  }
}

/**
 * fetch() that names its target on network failure. A raw fetch rejection
 * (DNS ENOTFOUND, ECONNREFUSED, timeout) is a bare "fetch failed" TypeError
 * that hides WHICH node endpoint died — exactly how stale COGNI_NODE_ENDPOINTS
 * (story.5016 / bug.5121) manifested. Logs slug + resolved URL and rethrows a
 * retryable RunHttpClientError (status 0), preserving Temporal retry semantics
 * (translateHttpError only short-circuits non-retryable errors).
 */
async function fetchNode(
  logger: Logger,
  nodeId: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code;
    logger.error(
      { nodeId, url, err: (err as Error).message, code },
      "node endpoint unreachable"
    );
    throw new RunHttpClientError(
      `${init.method ?? "GET"} ${url} (nodeId "${nodeId}") network failure${code ? ` [${code}]` : ""}: ${(err as Error).message}`,
      0,
      true
    );
  }
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
  const { schedulerApiToken, logger } = deps;

  async function postCreate(
    nodeId: string,
    body: InternalCreateGraphRunInput,
    instance: string | undefined
  ): Promise<void> {
    const base = await resolveBase(deps, nodeId, instance);
    const url = `${base}/api/internal/graph-runs`;
    const response = await fetchNode(logger, nodeId, url, {
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
    body: InternalUpdateGraphRunInput,
    instance: string | undefined
  ): Promise<void> {
    const base = await resolveBase(deps, nodeId, instance);
    const url = `${base}/api/internal/graph-runs/${encodeURIComponent(runId)}`;
    const response = await fetchNode(logger, nodeId, url, {
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
    async createRun(_actorId, nodeId, params, instance) {
      await postCreate(
        nodeId,
        {
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
        },
        instance
      );
    },

    async markRunStarted(_actorId, nodeId, runId, traceId, instance) {
      await patchUpdate(
        nodeId,
        runId,
        {
          status: "running",
          ...(traceId !== undefined && { traceId }),
        },
        instance
      );
    },

    async markRunCompleted(
      _actorId,
      nodeId,
      runId,
      status,
      errorMessage,
      errorCode,
      instance
    ) {
      await patchUpdate(
        nodeId,
        runId,
        {
          status,
          ...(errorMessage !== undefined && { errorMessage }),
          ...(errorCode !== undefined && { errorCode }),
        },
        instance
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant validator
// ─────────────────────────────────────────────────────────────────────────────

export function createHttpExecutionGrantValidator(
  deps: RunHttpAdapterDeps
): ExecutionGrantHttpValidator {
  const { schedulerApiToken, logger } = deps;

  async function validateGrantForScope(
    _actorId: Parameters<
      ExecutionGrantHttpValidator["validateGrantForScope"]
    >[0],
    nodeId: string,
    grantId: string,
    scope: string,
    instance?: string
  ) {
    const base = await resolveBase(deps, nodeId, instance);
    const url = `${base}/api/internal/grants/${encodeURIComponent(grantId)}/validate`;
    const response = await fetchNode(logger, nodeId, url, {
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
    async validateGrantForGraph(actorId, nodeId, grantId, graphId, instance) {
      return validateGrantForScope(
        actorId,
        nodeId,
        grantId,
        graphExecuteScope(graphId),
        instance
      );
    },
  };
}
