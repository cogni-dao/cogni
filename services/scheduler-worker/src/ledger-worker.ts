// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/ledger-worker`
 * Purpose: Temporal Worker for the ledger-tasks queue — epoch collection and enrichment workflows.
 * Scope: Creates Temporal Worker with ledger + enrichment activities and CollectEpochWorkflow. Does not contain business logic.
 * Invariants:
 *   - Separate task queue (ledger-tasks) from scheduler-tasks
 *   - All dependencies injected via AttributionContainer from bootstrap/container.ts
 *   - Per TEMPORAL_DETERMINISM: Workflows are bundled separately from activities
 * Side-effects: IO (connects to Temporal, starts worker)
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, https://cognidao.org/knowledge/temporal-workflow-rules
 * @internal
 */

import { createRequire } from "node:module";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createEnrichmentActivities } from "./activities/enrichment.js";
import { createAttributionActivities } from "./activities/ledger.js";
import type { AttributionContainer } from "./bootstrap/container.js";
import type { Env } from "./bootstrap/env.js";
import type { Logger } from "./observability/logger.js";

const require = createRequire(import.meta.url);

/** Task queue for ledger workflows — separate from scheduler-tasks */
export const LEDGER_TASK_QUEUE = "ledger-tasks";

export interface LedgerWorkerConfig {
  env: Env;
  logger: Logger;
  container: AttributionContainer;
}

/**
 * Starts the Temporal ledger worker for epoch collection workflows.
 * Returns a cleanup function to stop the worker gracefully.
 */
export async function startAttributionWorker(
  config: LedgerWorkerConfig
): Promise<{ shutdown: () => Promise<void> }> {
  const { env, logger, container } = config;

  // bug.5023: poll THIS node's own ledger queue, never the shared `ledger-tasks` (purged).
  // Each ledger worker is single-node (its own DB + scope from its repo-spec), so a shared
  // queue let a wrong-scope worker steal another node's finalize → "epoch not found" +
  // forced re-sign. Mirrors scheduler-tasks QUEUE_PER_NODE_ISOLATION.
  const ledgerTaskQueue = `${LEDGER_TASK_QUEUE}-${container.nodeId}`;

  logger.info(
    {
      temporalAddress: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: ledgerTaskQueue,
      nodeId: container.nodeId,
      scopeId: container.scopeId,
    },
    "Starting ledger worker"
  );

  const connection = await NativeConnection.connect({
    address: env.TEMPORAL_ADDRESS,
  });

  const ledgerActivities = createAttributionActivities({
    attributionStore: container.attributionStore,
    sourceRegistrations: container.sourceRegistrations,
    registries: container.registries,
    nodeId: container.nodeId,
    scopeId: container.scopeId,
    logger: container.logger,
  });

  const enrichmentActivities = createEnrichmentActivities({
    attributionStore: container.attributionStore,
    nodeId: container.nodeId,
    logger: container.logger,
    registries: container.registries,
  });

  const activities = { ...ledgerActivities, ...enrichmentActivities };

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: ledgerTaskQueue,
    workflowsPath: require.resolve("@cogni/temporal-workflows/ledger"),
    activities,
  });

  logger.info(
    { namespace: env.TEMPORAL_NAMESPACE, taskQueue: ledgerTaskQueue },
    "Ledger Worker created"
  );

  const runPromise = worker.run();

  runPromise.catch((err) => {
    logger.error({ err }, "Ledger worker run failed");
  });

  logger.info({}, "Ledger worker started, polling for tasks");

  return {
    shutdown: async () => {
      logger.info({}, "Shutting down Ledger Worker");
      worker.shutdown();
      await runPromise;
      await connection.close();
      logger.info({}, "Ledger Worker shutdown complete");
    },
  };
}
