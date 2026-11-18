// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/ports`
 * Purpose: Port barrel — interface contracts + typed error classes for worker HTTP-delegated persistence (task.0280).
 * Scope: Interfaces + throwable error classes + the pure main-instance predicate only. No framework deps, no concrete adapters, no runtime I/O. Error classes live here (not adapters/) so activities/ can import them without violating the clean-architecture boundary.
 * Invariants: Named exports only; activities/ imports only from this module; adapter impl lives in adapters/run-http.ts.
 * Side-effects: none
 * Links: Consumed by activities/, workflows/, bootstrap/, and adapters/run-http.ts
 * @public
 */

// Ledger ports from @cogni/attribution-ledger
export type { AttributionStore } from "@cogni/attribution-ledger";
// Ingestion ports from @cogni/ingestion-core
export type {
  CollectParams,
  CollectResult,
  DataSourceRegistration,
  PollAdapter,
  SourceAdapter,
  StreamCursor,
  WebhookNormalizer,
} from "@cogni/ingestion-core";

// Scheduler run + grant writers are HTTP-delegated (task.0280). Port interfaces
// live here; HTTP adapters in services/scheduler-worker/src/adapters/run-http.ts
// implement them. Activities import these types only — never the adapter module.
// The direct-DB ports (GraphRunRepository, ExecutionGrantWorkerPort) stay in
// @cogni/scheduler-core for node-app use.

import type { ActorId } from "@cogni/ids";
import type {
  InternalReviewCreateCheckRunInput,
  InternalReviewPostPrCommentInput,
  InternalReviewPostPrCommentOutput,
  InternalReviewPrContextInput,
  InternalReviewPrContextOutput,
  InternalReviewUpdateCheckRunInput,
} from "@cogni/node-contracts";
import type { ExecutionGrant, GraphRunKind } from "@cogni/scheduler-core";

/** Write subset of graph_runs persistence, routed by nodeId. */
export interface GraphRunHttpWriter {
  createRun: (
    actorId: ActorId,
    nodeId: string,
    params: {
      runId: string;
      graphId?: string;
      runKind?: GraphRunKind;
      triggerSource?: string;
      triggerRef?: string;
      requestedBy?: string;
      scheduleId?: string;
      scheduledFor?: Date;
      stateKey?: string;
    },
    /** The copy of the node the run belongs to; absent or `main` = the node's main copy. */
    instance?: string
  ) => Promise<void>;

  markRunStarted: (
    actorId: ActorId,
    nodeId: string,
    runId: string,
    traceId?: string,
    instance?: string
  ) => Promise<void>;

  markRunCompleted: (
    actorId: ActorId,
    nodeId: string,
    runId: string,
    status: "success" | "error" | "timeout" | "skipped" | "cancelled",
    errorMessage?: string,
    errorCode?: string,
    instance?: string
  ) => Promise<void>;
}

/**
 * GitHub-plane client for PR review, HTTP-delegated to the operator's internal
 * review API (bug.5000). The worker holds no GitHub credential; every call
 * routes to the operator with Bearer SCHEDULER_API_TOKEN.
 */
export interface ReviewHttpClient {
  createCheckRun: (input: InternalReviewCreateCheckRunInput) => Promise<number>;
  updateCheckRun: (input: InternalReviewUpdateCheckRunInput) => Promise<void>;
  postPrComment: (
    input: InternalReviewPostPrCommentInput
  ) => Promise<InternalReviewPostPrCommentOutput>;
  fetchPrContext: (
    input: InternalReviewPrContextInput
  ) => Promise<InternalReviewPrContextOutput>;
}

/**
 * Per-node dispatch principal (G1, task.5029 — the seam to the secrets-on-spawn
 * work). Resolves the wire credential a NodeTask dispatch authenticates with,
 * scoped to ONE node. FAIL-CLOSED: the shared `SCHEDULER_API_TOKEN` must NOT be
 * a fallback — an unprovisioned node MUST throw, so a NodeTaskWorkflow can never
 * silently run under the shared credential (the per-node attribution + blast-
 * radius isolation the design exists to create). The credential *provisioning*
 * is a separate dev's job; this port only declares the slot it must fill.
 */
export interface NodePrincipalResolver {
  /** @throws NodePrincipalUnprovisionedError when the node has no per-node credential. */
  resolve: (nodeId: string) => Promise<{ token: string }>;
}

/**
 * Thrown by NodePrincipalResolver when a node has no provisioned per-node
 * dispatch credential. Non-retryable: the credential won't appear on retry
 * (provisioning is out-of-band). This is the CI/review gate that keeps a
 * shared-token NodeTask from counting as "done".
 */
export class NodePrincipalUnprovisionedError extends Error {
  readonly code = "node_principal_unprovisioned" as const;
  constructor(nodeId: string) {
    super(
      `No per-node dispatch principal provisioned for node ${nodeId} (fail-closed — shared SCHEDULER_API_TOKEN is NOT a fallback)`
    );
    this.name = "NodePrincipalUnprovisionedError";
  }
}

/** Grant validation routed by nodeId — returns the grant on success, throws on 403. */
export interface ExecutionGrantHttpValidator {
  /**
   * Validate a grant for a generalized scope (M2, task.5029). The dispatched
   * `nodeId` is sent to the node so it can assert the grant↔node binding (M1).
   */
  validateGrantForScope: (
    actorId: ActorId,
    nodeId: string,
    grantId: string,
    scope: string,
    instance?: string
  ) => Promise<ExecutionGrant>;

  /** Back-compat: validate a grant for `graph:execute:<graphId>`. */
  validateGrantForGraph: (
    actorId: ActorId,
    nodeId: string,
    grantId: string,
    graphId: string,
    instance?: string
  ) => Promise<ExecutionGrant>;
}

/**
 * Resolves the base URL of ONE NON-MAIN instance of a node (story.5159 step 1, design hub
 * `candidate-pr-lanes`). The main copy never goes through this port: it resolves from COGNI_NODE_ENDPOINTS
 * exactly as before. An instance is named by identity, never by a URL taken from run input.
 */
export interface InstanceUrlResolver {
  /** @throws InstanceUnresolvedError when the instance is unknown, closed, or the directory cannot say. */
  resolve: (nodeId: string, instance: string) => Promise<string>;
}

/** The instance name of a node's main copy. It resolves from COGNI_NODE_ENDPOINTS, never the directory. */
export const MAIN_INSTANCE = "main";

/** True when a run names the node's main copy: no instance at all, or `main`. */
export function isMainInstance(instance: string | undefined): boolean {
  return instance === undefined || instance === MAIN_INSTANCE;
}

/**
 * Thrown when a non-main instance has no host to call. `retryable` is false when the directory said the
 * instance is absent or closed (or the worker has no directory): the answer will not change on retry, and
 * NO request has been sent to any host. It is true only when the operator could not be reached and no
 * last-good copy exists. The worker never falls back to the main copy.
 */
export class InstanceUnresolvedError extends Error {
  readonly code = "UNKNOWN_INSTANCE" as const;
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "InstanceUnresolvedError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error types raised by the HTTP adapters. Defined in the ports module so that
// activities/ can import them without violating the clean-architecture rule
// (activities never import adapters). The adapter implementation throws these;
// activities catch and translate to Temporal ApplicationFailure.
// ─────────────────────────────────────────────────────────────────────────────

/** Any HTTP-layer failure not mapped to a grant-specific error. */
export class RunHttpClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "RunHttpClientError";
  }
}

export class GrantNotFoundError extends Error {
  readonly code = "grant_not_found" as const;
  constructor(grantId: string) {
    super(`Grant not found: ${grantId}`);
    this.name = "GrantNotFoundError";
  }
}
export class GrantExpiredError extends Error {
  readonly code = "grant_expired" as const;
  constructor(grantId: string) {
    super(`Grant expired: ${grantId}`);
    this.name = "GrantExpiredError";
  }
}
export class GrantRevokedError extends Error {
  readonly code = "grant_revoked" as const;
  constructor(grantId: string) {
    super(`Grant revoked: ${grantId}`);
    this.name = "GrantRevokedError";
  }
}
export class GrantScopeMismatchError extends Error {
  readonly code = "grant_scope_mismatch" as const;
  constructor(grantId: string, scope: string) {
    super(`Grant scope mismatch: ${grantId} cannot perform ${scope}`);
    this.name = "GrantScopeMismatchError";
  }
}
/** M1 (task.5029): grant is not bound to the dispatched node. Fail-closed, non-retryable. */
export class GrantNodeMismatchError extends Error {
  readonly code = "grant_node_mismatch" as const;
  constructor(grantId: string, nodeId: string) {
    super(`Grant node mismatch: ${grantId} is not bound to node ${nodeId}`);
    this.name = "GrantNodeMismatchError";
  }
}
