// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-sync-service/reconcile`
 * Purpose: The scheduled reconciliation loop — periodically `dolt_push` a node's
 *   knowledge DB to its DoltHub remote, healing best-effort on-merge push gaps.
 * Scope: Gating (buildRemoteAdapter) + the interval loop with drain semantics.
 * Invariants:
 *   - MIRROR_BEST_EFFORT_NO_RETRY: a failed push is logged, never retried within a
 *     tick, never throws out of the loop. The next tick is the recovery.
 *   - Non-overlapping: a tick is skipped while a push is in flight.
 *   - Gate-by-secret-presence: no DOLTGRES_URL+DOLTHUB_REMOTE_URL → mirror disabled (no-op).
 *   - Drain: stop() clears the timer, awaits any in-flight push, closes the client.
 * Side-effects: IO (Doltgres SQL connection; outbound push), timers
 * Links: docs/spec/knowledge-data-plane.md
 * @internal
 */

import postgres from "postgres";
import { createDoltGrpcRemoteAdapter } from "./adapters/dolt-grpc-remote.js";
import { isMirrorEnabled, type KnowledgeSyncConfig } from "./config.js";
import {
  EVENT,
  type Logger,
  lastPushSuccessTimestamp,
  mirrorEnabled,
  pushDurationMs,
  pushTotal,
} from "./observability/index.js";
import type { DoltRemotePort } from "./ports/dolt-remote.port.js";

/**
 * Build the live remote adapter when the mirror is configured, else null
 * (healthy no-op). The DoltHub push creds live in the Doltgres SERVER; this
 * client only opens a low-frequency SQL connection to trigger `dolt_push`.
 */
export function buildRemoteAdapter(
  config: KnowledgeSyncConfig,
  logger: Logger
): DoltRemotePort | null {
  if (!isMirrorEnabled(config)) {
    logger.info(
      {
        event: EVENT.DISABLED,
        node: config.SYNC_NODE,
        hasDoltgresUrl: Boolean(config.DOLTGRES_URL),
        hasRemoteUrl: Boolean(config.DOLTHUB_REMOTE_URL),
      },
      "Knowledge mirror disabled (DOLTGRES_URL + DOLTHUB_REMOTE_URL required) — idling"
    );
    return null;
  }

  const sql = postgres(config.DOLTGRES_URL as string, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
    fetch_types: false,
    connection: { application_name: "cogni_knowledge_sync" },
  });

  return createDoltGrpcRemoteAdapter({
    sql,
    node: config.SYNC_NODE,
    remoteName: config.SYNC_REMOTE_NAME,
    remoteUrl: config.DOLTHUB_REMOTE_URL as string,
    branch: config.SYNC_BRANCH,
  });
}

export interface Reconciler {
  /** Run a single reconciliation immediately (used on start + each tick). */
  runOnce(): Promise<void>;
  /** Stop the timer, drain any in-flight push, close the client. */
  stop(): Promise<void>;
}

export function startReconciler(args: {
  config: KnowledgeSyncConfig;
  remote: DoltRemotePort | null;
  logger: Logger;
}): Reconciler {
  const { config, remote, logger } = args;
  const node = config.SYNC_NODE;
  mirrorEnabled.set({ node }, remote ? 1 : 0);

  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function pushOnce(): Promise<void> {
    if (!remote) {
      logger.debug(
        { event: EVENT.TICK, node, enabled: false },
        "tick (mirror disabled)"
      );
      return;
    }
    const startedAt = Date.now();
    logger.info(
      { event: EVENT.PUSH_START, node, remoteKind: remote.kind },
      "push start"
    );
    const signal = AbortSignal.timeout(config.SYNC_PUSH_TIMEOUT_MS);
    try {
      const result = await remote.push(signal);
      const durationMs = Date.now() - startedAt;
      pushDurationMs.set({ node }, durationMs);
      pushTotal.inc({ node, outcome: "ok" });
      lastPushSuccessTimestamp.set({ node }, Math.floor(Date.now() / 1000));
      logger.info(
        { event: EVENT.PUSH_OK, node, branch: result.branch, durationMs },
        "push ok"
      );
    } catch (err) {
      pushDurationMs.set({ node }, Date.now() - startedAt);
      pushTotal.inc({ node, outcome: "error" });
      // best-effort: log + drop. The next tick is the recovery.
      logger.warn(
        { event: EVENT.PUSH_ERROR, node, err: errString(err) },
        "push failed (best-effort, will retry next tick)"
      );
    }
  }

  function runOnce(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      logger.debug(
        { event: EVENT.TICK, node, skipped: "in-flight" },
        "tick skipped"
      );
      return inFlight;
    }
    inFlight = pushOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  if (config.SYNC_RUN_ON_START) {
    void runOnce();
  }
  timer = setInterval(
    () => void runOnce(),
    config.SYNC_INTERVAL_SECONDS * 1000
  );
  // Don't keep the event loop alive solely for the timer during shutdown.
  if (typeof timer.unref === "function") timer.unref();

  return {
    runOnce,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      if (remote) await remote.close().catch(() => undefined);
    },
  };
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
