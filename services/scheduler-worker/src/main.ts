// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/main`
 * Purpose: Service entry point with graceful shutdown. Starts scheduler + optional ledger worker.
 * Scope: Entry point that calls env() and starts Temporal workers. Does not contain business logic.
 * Invariants:
 *   - Reads config from env (no hardcoded values)
 *   - Handles SIGTERM/SIGINT for graceful shutdown
 *   - Per READINESS_GATES_LOCALLY: ready=false stops work intake immediately
 *   - Both workers must start before ready=true
 * Side-effects: IO (Temporal connection, process signals)
 * Links: docs/spec/scheduler.md, docs/spec/services-architecture.md
 * @public
 */

import { createAttributionContainer } from "./bootstrap/container.js";
import { env } from "./bootstrap/env.js";
import { type HealthState, startHealthServer } from "./health.js";
import { startAttributionWorker } from "./ledger-worker.js";
import {
  flushLogger,
  logWorkerEvent,
  makeLogger,
  schedulerWorkerNodeReachable,
  WORKER_EVENT_NAMES,
  workerInfo,
} from "./observability/index.js";
import { startSchedulerWorker } from "./worker.js";

/**
 * Per task.0280 phase 2: fire-and-forget reachability probe for every node in
 * COGNI_NODE_ENDPOINTS. Never blocks boot. The worker's only hard startup
 * dependency is Temporal. Per-node unreachability becomes a metric + log.
 */
function probeNodeReachability(
  nodeEndpointsRaw: string,
  logger: ReturnType<typeof makeLogger>
): void {
  for (const pair of nodeEndpointsRaw.split(",")) {
    const [rawNodeId, ...rest] = pair.trim().split("=");
    const nodeId = rawNodeId?.trim();
    const url = rest.join("=").trim();
    if (!nodeId || !url) continue;

    (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/readyz`, {
          signal: controller.signal,
        });
        if (response.ok) {
          schedulerWorkerNodeReachable.set({ node_id: nodeId }, 1);
        } else {
          schedulerWorkerNodeReachable.set({ node_id: nodeId }, 0);
          logger.warn(
            { nodeId, url, status: response.status },
            "Node /readyz returned non-2xx at worker boot (non-blocking)"
          );
        }
      } catch (err) {
        schedulerWorkerNodeReachable.set({ node_id: nodeId }, 0);
        logger.warn(
          { nodeId, url, err: (err as Error).message },
          "Node /readyz unreachable at worker boot (non-blocking)"
        );
      } finally {
        clearTimeout(timeout);
      }
    })();
  }
}

async function main(): Promise<void> {
  // Load and validate env
  const config = env();

  // Create logger (composition root owns logger creation)
  const logger = makeLogger();

  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    logLevel: config.LOG_LEVEL,
  });

  // Health state for readiness probes
  const healthState: HealthState = { ready: false };
  startHealthServer(healthState, config.HEALTH_PORT);
  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    port: config.HEALTH_PORT,
    phase: "health_server",
  });

  // Shutdown handles for all workers
  const shutdownHandles: Array<{ shutdown: () => Promise<void> }> = [];

  // Kick off reachability probes in parallel with worker start — never block.
  probeNodeReachability(config.COGNI_NODE_ENDPOINTS, logger);

  // Start scheduler worker (always)
  const schedulerWorker = await startSchedulerWorker({ env: config, logger });
  shutdownHandles.push(schedulerWorker);
  healthState.inspectTemporalPollers = schedulerWorker.inspectTemporalPollers;

  // Start ledger worker (optional — requires NODE_ID + SCOPE_ID)
  const ledgerContainer = createAttributionContainer(config, logger);
  if (ledgerContainer) {
    const ledgerWorker = await startAttributionWorker({
      env: config,
      logger,
      container: ledgerContainer,
    });
    shutdownHandles.push(ledgerWorker);
    logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
      phase: "ledger_worker",
    });
  }

  // Mark ready after all workers start
  healthState.ready = true;
  workerInfo.set({ task_queue: config.TEMPORAL_TASK_QUEUE }, 1);
  // Log adapter coverage for diagnostics (P0 visibility)
  if (ledgerContainer) {
    const registeredSources = [...ledgerContainer.sourceRegistrations.keys()];
    logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_READY, {
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      ledgerEnabled: true,
      ledgerTaskQueue: `ledger-tasks-${ledgerContainer.nodeId}`,
      nodeId: ledgerContainer.nodeId,
      scopeId: ledgerContainer.scopeId,
      chainId: ledgerContainer.chainId,
      registeredSources,
      registeredSourceCount: registeredSources.length,
    });
  } else {
    logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_READY, {
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      ledgerEnabled: false,
    });
  }

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn(
        { event: WORKER_EVENT_NAMES.LIFECYCLE_SHUTDOWN, signal },
        "Shutdown already in progress"
      );
      return;
    }
    shuttingDown = true;
    healthState.ready = false; // Stop accepting new work
    logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_SHUTDOWN, { signal });

    try {
      await Promise.all(shutdownHandles.map((h) => h.shutdown()));
      logWorkerEvent(
        logger,
        WORKER_EVENT_NAMES.LIFECYCLE_SHUTDOWN_COMPLETE,
        {}
      );
      flushLogger();
      process.exit(0);
    } catch (err) {
      logger.error(
        { event: WORKER_EVENT_NAMES.LIFECYCLE_FATAL, err },
        WORKER_EVENT_NAMES.LIFECYCLE_FATAL
      );
      flushLogger();
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const bootLogger = makeLogger({ phase: "boot" });

main().catch((err) => {
  bootLogger.fatal(
    { event: WORKER_EVENT_NAMES.LIFECYCLE_FATAL, err },
    WORKER_EVENT_NAMES.LIFECYCLE_FATAL
  );
  flushLogger();
  process.exit(1);
});
