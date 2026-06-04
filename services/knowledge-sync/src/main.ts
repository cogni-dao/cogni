// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-sync-service/main`
 * Purpose: Service entry point — start the health server + the reconciliation loop.
 * Scope: Composition root: loadConfig() → buildRemoteAdapter() → startReconciler().
 * Invariants:
 *   - Reads config from env (no hardcoded values).
 *   - Handles SIGTERM/SIGINT for graceful shutdown: ready=false → drain push → close → exit.
 *   - Boots healthy even when the mirror is disabled (gate-by-secret-presence).
 * Side-effects: IO (Doltgres connection, HTTP health server, process signals)
 * Links: docs/spec/services-architecture.md, docs/spec/knowledge-data-plane.md
 * @public
 */

import { loadConfig } from "./config.js";
import { type HealthState, startHealthServer } from "./health.js";
import { EVENT, flushLogger, makeLogger } from "./observability/index.js";
import { buildRemoteAdapter, startReconciler } from "./reconcile.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = makeLogger();

  logger.info(
    {
      event: EVENT.LIFECYCLE_STARTING,
      logLevel: config.LOG_LEVEL,
      node: config.SYNC_NODE,
    },
    "knowledge-sync starting"
  );

  const healthState: HealthState = { ready: false };
  startHealthServer(healthState, config.HEALTH_PORT);

  const remote = buildRemoteAdapter(config, logger);
  const reconciler = startReconciler({ config, remote, logger });

  healthState.ready = true;
  logger.info(
    {
      event: EVENT.LIFECYCLE_READY,
      node: config.SYNC_NODE,
      mirrorEnabled: Boolean(remote),
      remoteKind: remote?.kind ?? "none",
      intervalSeconds: config.SYNC_INTERVAL_SECONDS,
      healthPort: config.HEALTH_PORT,
    },
    "knowledge-sync ready"
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthState.ready = false;
    logger.info(
      { event: EVENT.LIFECYCLE_SHUTDOWN, signal, node: config.SYNC_NODE },
      "shutting down"
    );
    try {
      await reconciler.stop();
      flushLogger();
      process.exit(0);
    } catch (err) {
      logger.error({ event: EVENT.LIFECYCLE_FATAL, err }, "shutdown error");
      flushLogger();
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const bootLogger = makeLogger({ phase: "boot" });
main().catch((err) => {
  bootLogger.fatal({ event: EVENT.LIFECYCLE_FATAL, err }, "fatal boot error");
  flushLogger();
  process.exit(1);
});
