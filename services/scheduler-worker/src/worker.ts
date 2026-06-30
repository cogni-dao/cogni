// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/worker`
 * Purpose: Temporal Worker bootstrap and lifecycle management.
 * Scope: Creates one Temporal Worker per node (plus a legacy-queue drain Worker) in a single pod. Does not contain business logic.
 * Invariants:
 *   - Per WORKER_NEVER_CONTROLS_SCHEDULES: Does NOT depend on ScheduleControlPort
 *   - Per TEMPORAL_DETERMINISM: Workflows are bundled separately from activities
 *   - Workflow bundle is built ONCE (bundleWorkflowCode) and shared across every
 *     per-node Worker — never re-bundled per queue (O(nodes) webpack at boot
 *     crashlooped the pod and took the fleet down, incident 2026-06-26)
 *   - Per QUEUE_PER_NODE_ISOLATION (task.0280 phase 2): one Temporal Worker per nodeId polling `scheduler-tasks-${nodeId}`. A failing node's queue growing does not starve other nodes. Required for chat.completions / ai.chat which submit from node-apps to `scheduler-tasks-${getNodeId()}` — stale scheduler-worker images that only poll the legacy queue will hang every user chat request.
 *   - All dependencies injected via ServiceContainer from bootstrap/container.ts
 *   - No concrete adapter imports — uses container for wiring
 * Side-effects: IO (connects to Temporal, starts workers)
 * Links: docs/spec/scheduler.md, docs/spec/temporal-patterns.md, docs/spec/multi-node-tenancy.md
 * @internal
 */

import { createRequire } from "node:module";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
} from "@temporalio/worker";
import { createGoalLoopActivities } from "./activities/goal-loop.js";
import { createActivities } from "./activities/index.js";
import { createReviewActivities } from "./activities/review.js";
import { createSweepActivities } from "./activities/sweep.js";
import { createContainer } from "./bootstrap/container.js";
import type { Env } from "./bootstrap/env.js";
import { logWorkerEvent, WORKER_EVENT_NAMES } from "./observability/index.js";
import type { Logger } from "./observability/logger.js";

const require = createRequire(import.meta.url);

/**
 * Configuration for starting the Temporal scheduler worker.
 */
export interface SchedulerWorkerConfig {
  /** Validated environment */
  env: Env;
  /** Logger instance */
  logger: Logger;
}

/**
 * Per-node queue naming. Must match what node-app submitters use
 * (nodes/*\/app/src/bootstrap/container.ts::getTemporalWorkflowClient).
 * Derived from the legacy queue name so "scheduler-tasks" → "scheduler-tasks-<nodeId>".
 */
export function nodeTaskQueueName(basePrefix: string, nodeId: string): string {
  return `${basePrefix}-${nodeId}`;
}

/**
 * `repo-spec.node_id` is a UUID; node-app submitters call
 * `getNodeId()` which returns that UUID. `COGNI_NODE_ENDPOINTS` registers
 * both the UUID and a human slug (e.g. "poly") pointing at the same URL —
 * the slug is a convenience alias for the map, not a submitter identity.
 * Workers must therefore poll queues keyed by UUID to match submitters;
 * slug entries are skipped.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCanonicalNodeId(nodeId: string): boolean {
  return UUID_RE.test(nodeId);
}

/**
 * True if an error thrown by `NativeConnection.connect` looks transient — a
 * DNS / transport / reachability blip that a retry could clear — rather than a
 * permanent misconfiguration. Matches broadly on error type/name and message:
 * a single transient name-resolution failure resolving the Temporal
 * ExternalName at boot must NOT be fatal (it crashlooped the pod and, on the
 * shared k3s VM, storm-degraded co-located node-apps → fleet 502, incident
 * 2026-06-30). When unsure, prefer retrying: transient transport errors at
 * boot should retry rather than crashloop.
 */
export function isTransientConnectError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; code?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  // Temporal's native transport surfaces these as `TransportError`.
  if (name === "TransportError") return true;
  const haystack = `${name} ${code} ${message}`;
  const TRANSIENT_MARKERS = [
    "name resolution",
    "dns error",
    "ENOTFOUND",
    "EAI_AGAIN",
    "Temporary failure",
    "ConnectError",
    "Connection refused",
    "UNAVAILABLE",
  ];
  return TRANSIENT_MARKERS.some((marker) =>
    haystack.toLowerCase().includes(marker.toLowerCase())
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Tunables + injectable timer for connectWithRetry (test seam). */
export interface ConnectWithRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Connect to Temporal with exponential backoff on transient
 * connection/transport/DNS errors. A single transient name-resolution blip at
 * boot must not be fatal — without this the pod crashloops on the same blip
 * (~every 60s) and storms the shared k3s VM (incident 2026-06-30). Persistent
 * (non-transient) failures rethrow immediately; transient failures rethrow only
 * after attempts are exhausted, so k8s still restarts on genuinely-down
 * Temporal — same outer behavior as before, but only after a real outage.
 *
 * The connect function, sleep timer, and tunables are injected so the retry
 * loop is deterministically unit-testable without a real Temporal or real
 * timers (the candidate-a flight booted first-try, so the loop was otherwise
 * never exercised).
 */
export async function connectWithRetry(
  connect: () => Promise<NativeConnection>,
  logger: Logger,
  opts?: ConnectWithRetryOptions
): Promise<NativeConnection> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const baseDelayMs = opts?.baseDelayMs ?? 2_000;
  const factor = opts?.factor ?? 2;
  const maxDelayMs = opts?.maxDelayMs ?? 15_000;
  const sleep = opts?.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await connect();
    } catch (err) {
      lastErr = err;
      if (!isTransientConnectError(err) || attempt === maxAttempts) break;
      const delayMs = Math.min(
        baseDelayMs * factor ** (attempt - 1),
        maxDelayMs
      );
      logger.warn(
        {
          event: WORKER_EVENT_NAMES.LIFECYCLE_STARTING,
          phase: "temporal_connect_retry",
          attempt,
          maxAttempts,
          delayMs,
          err: (err as Error)?.message ?? String(err),
        },
        `Temporal connect failed (transient) — retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`
      );
      await sleep(delayMs);
    }
  }
  logger.warn(
    {
      event: WORKER_EVENT_NAMES.LIFECYCLE_STARTING,
      phase: "temporal_connect_exhausted",
      maxAttempts,
      err: (lastErr as Error)?.message ?? String(lastErr),
    },
    "Exhausted Temporal connect retries — rethrowing (k8s will restart)"
  );
  throw lastErr;
}

/**
 * Starts one Temporal Worker per canonical nodeId in COGNI_NODE_ENDPOINTS,
 * plus one drain Worker on the legacy `env.TEMPORAL_TASK_QUEUE` for any
 * schedules that have not yet been rewritten to a per-node queue.
 *
 * Failure of any individual Worker is logged but does not tear down the
 * others: a flapping poly queue must not starve operator or resy traffic.
 */
export async function startSchedulerWorker(
  config: SchedulerWorkerConfig
): Promise<{ shutdown: () => Promise<void> }> {
  const { env, logger } = config;

  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    temporalAddress: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    legacyTaskQueue: env.TEMPORAL_TASK_QUEUE,
    phase: "temporal_connect",
  });

  // Wrap connect in retry-with-backoff: a single transient DNS blip resolving
  // the Temporal ExternalName at boot must not crashloop the pod (incident
  // 2026-06-30). See connectWithRetry / isTransientConnectError above.
  const connection = await connectWithRetry(
    () => NativeConnection.connect({ address: env.TEMPORAL_ADDRESS }),
    logger
  );

  const container = createContainer(env, logger);

  const graphActivities = createActivities({
    grantAdapter: container.grantAdapter,
    runAdapter: container.runAdapter,
    nodePrincipalResolver: container.nodePrincipalResolver,
    config: container.config,
    logger:
      container.logger.child?.({ component: "activities" }) ?? container.logger,
  });

  // Review activities register unconditionally (bug.5000): they hold no GitHub
  // credential — every GitHub call is HTTP-delegated to the operator's review
  // plane via container.reviewClient (operator endpoint + SCHEDULER_API_TOKEN,
  // which the worker already has).
  const reviewActivities = createReviewActivities({
    reviewClient: container.reviewClient,
    logger:
      container.logger.child?.({ component: "review-activities" }) ??
      container.logger,
  });

  // Sweep activities poll the operator's work-items API, so they only apply
  // when the formation includes an operator node. Catalog/formation-driven:
  // if COGNI_NODE_ENDPOINTS has no "operator" entry (e.g. a candidate slot
  // scoped to a node subset like canary + node-template), skip sweep and boot
  // with graph + review activities only — do NOT hard-fail. A fatal throw here
  // made any operator-less formation impossible, contra the catalog model.
  const operatorBaseUrl = container.config.nodeEndpoints.get("operator");
  const sweepActivities = operatorBaseUrl
    ? createSweepActivities({
        config: {
          operatorBaseUrl,
          schedulerApiToken: container.config.schedulerApiToken,
        },
        logger:
          container.logger.child?.({ component: "sweep-activities" }) ??
          container.logger,
      })
    : {};
  if (!operatorBaseUrl) {
    container.logger.warn?.(
      'COGNI_NODE_ENDPOINTS has no "operator" entry — sweep activities disabled (formation without operator)'
    );
  }

  // Goal-loop activities register unconditionally: they hold no DB cred — every
  // op HTTP-delegates to the owning node's /api/internal/goal-loop route via
  // container.config (node endpoints + SCHEDULER_API_TOKEN the worker already
  // has). Mirrors the review-activity delegation pattern (bug.5000).
  const goalLoopActivities = createGoalLoopActivities({
    nodeEndpoints: container.config.nodeEndpoints,
    schedulerApiToken: container.config.schedulerApiToken,
    logger:
      container.logger.child?.({ component: "goal-loop-activities" }) ??
      container.logger,
  });

  const allActivities = {
    ...graphActivities,
    ...reviewActivities,
    ...sweepActivities,
    ...goalLoopActivities,
  };
  const workflowsPath = require.resolve("@cogni/temporal-workflows/scheduler");

  // Build the Workflow bundle ONCE and reuse it for every per-node Worker.
  // Worker.create({ workflowsPath }) re-runs webpack on each call; with one
  // Worker per node that is O(nodes) ~3MB compilations at boot — which blocked
  // the event loop, starved the liveness probe, crashlooped the pod and (via
  // the readiness coupling) took the whole fleet down (incident 2026-06-26).
  // The bundle is identical across nodes (same workflow code), so it is built a
  // single time here. Further optimization: move bundling to image-build time.
  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    phase: "bundle_workflows",
  });
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });

  // Per QUEUE_PER_NODE_ISOLATION: build the nodeId set from the endpoint map
  // (filtering to UUIDs, which are canonical; slug entries are convenience
  // aliases for URL lookup), create one Worker per node, and always include
  // the legacy queue as a drain until all Schedules are rewritten.
  const nodeIds = [...container.config.nodeEndpoints.keys()].filter(
    isCanonicalNodeId
  );
  const legacyQueue = env.TEMPORAL_TASK_QUEUE;
  if (nodeIds.length === 0) {
    // Fail-loud config drift check: node-app submitters use repo-spec UUIDs
    // as the nodeId, so a worker with no UUID endpoints will starve every
    // per-node queue. k8s overlays and compose files MUST register UUID
    // aliases alongside slug aliases. See docs/spec/multi-node-tenancy.md
    // QUEUE_PER_NODE_ISOLATION.
    logger.error(
      {
        endpointKeys: [...container.config.nodeEndpoints.keys()],
      },
      "COGNI_NODE_ENDPOINTS has no UUID nodeId entries — worker will only poll the legacy drain queue and all new per-node submissions will starve. Add repo-spec UUID aliases to COGNI_NODE_ENDPOINTS."
    );
  }
  const queues = new Set<string>([
    ...nodeIds.map((id) => nodeTaskQueueName(legacyQueue, id)),
    legacyQueue,
  ]);

  type StartedWorker = {
    taskQueue: string;
    worker: Worker;
    run: Promise<void>;
  };
  const started: StartedWorker[] = [];
  for (const taskQueue of queues) {
    try {
      const worker = await Worker.create({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue,
        // Reuse the single pre-built bundle instead of re-bundling per queue.
        workflowBundle,
        activities: allActivities,
      });
      const run = worker.run();
      // Per-worker isolation: log the failure, do NOT let it reject the
      // composite shutdown promise.
      run.catch((err) => {
        logger.error(
          { event: WORKER_EVENT_NAMES.LIFECYCLE_FATAL, taskQueue, err },
          `${WORKER_EVENT_NAMES.LIFECYCLE_FATAL}: taskQueue=${taskQueue}`
        );
      });
      started.push({ taskQueue, worker, run });
      logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue,
        isLegacyDrain: taskQueue === legacyQueue,
        phase: "worker_created",
      });
    } catch (err) {
      logger.error(
        { taskQueue, err },
        "Failed to start Temporal Worker for queue — continuing with remaining queues"
      );
    }
  }

  if (started.length === 0) {
    throw new Error(
      "No Temporal Workers started — all queue creations failed. Check Temporal reachability."
    );
  }

  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    phase: "polling",
    queues: started.map((s) => s.taskQueue),
  });

  return {
    shutdown: async () => {
      logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_SHUTDOWN, {
        phase: "temporal_worker",
        queueCount: started.length,
      });
      for (const s of started) s.worker.shutdown();
      // Wait for all workers in parallel; swallow individual errors so one
      // stuck queue can't block overall shutdown.
      await Promise.allSettled(started.map((s) => s.run));
      await connection.close();
      logWorkerEvent(
        logger,
        WORKER_EVENT_NAMES.LIFECYCLE_SHUTDOWN_COMPLETE,
        {}
      );
    },
  };
}
