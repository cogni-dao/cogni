// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/database-recovery-watchdog`
 * Purpose: Independently enforce native recovery deadlines and publish bounded liveness.
 * Scope: Private-image watchdog mode; does not read catalog, metrics, Loki, or the application database.
 * Invariants: BOOT_ENUMERATION, NATIVE_CLOCK, EARLY_RECONTAIN, NO_LOGIN_CAPABILITY.
 * Side-effects: IO, time, global
 * Links: task.5247, infra/compose/runtime/postgres-init/apply-control.sql
 * @internal
 */

import { createServer } from "node:http";
import pino from "pino";
import {
  createCellAdminRecoveryControls,
  PostgresAdminSqlAdapter,
  PostgresDatabaseRecoveryWatchdogAdapter,
} from "@/adapters/server";
import type { DatabaseEnvironment } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

export async function runDatabaseRecoveryWatchdog(input: {
  readonly environment: DatabaseEnvironment;
  readonly buildSha: string;
  readonly ownerId: string;
  readonly adminDsn: string;
  readonly cellAdminBindings?: unknown;
}): Promise<never> {
  if (!/^[0-9a-f-]{36}$/.test(input.ownerId)) {
    throw new Error("database_recovery_watchdog_pod_identity_missing");
  }
  const log = pino().child({
    service: "database-reliability-watchdog",
    buildSha: input.buildSha,
    environment: input.environment,
    ownerId: input.ownerId,
  });
  const sql = new PostgresAdminSqlAdapter(input.adminDsn);
  const watchdog = new PostgresDatabaseRecoveryWatchdogAdapter(sql);
  const cells = createCellAdminRecoveryControls(input.cellAdminBindings ?? []);
  const cellLedgers = cells.filter(
    (cell, index) =>
      cells.findIndex(
        (row) =>
          row.binding.substrateHost === cell.binding.substrateHost &&
          row.binding.environment === cell.binding.environment
      ) === index
  );
  let running = false;
  let stopping = false;
  let lastTickAt: number | null = null;
  async function tick(): Promise<void> {
    if (running || stopping) return;
    running = true;
    try {
      const receipts = await Promise.allSettled([
        watchdog.tick(input),
        ...cellLedgers.map(async (cell) => {
          const receipt = await cell.watchdog.tick({
            environment: cell.binding.environment,
            ownerId: input.ownerId,
          });
          if (
            receipt.transitions.some(
              (incident) =>
                incident.nodeId !== cell.binding.nodeId ||
                incident.databaseSystemIdentifier !==
                  cell.binding.systemIdentifier
            )
          )
            throw new Error(
              "database_recovery_cell_watchdog_identity_mismatch"
            );
          return receipt;
        }),
      ]);
      lastTickAt = receipts.every((result) => result.status === "fulfilled")
        ? Date.now()
        : null;
      for (const result of receipts) {
        if (result.status === "rejected") {
          log.error({
            event: "feature.node_reliability.watchdog.failed",
            error: result.reason,
          });
          continue;
        }
        const receipt = result.value;
        for (const incident of receipt.transitions) {
          log.info(
            {
              event: EVENT_NAMES.NODE_RELIABILITY_TRANSITION,
              action: "recontained",
              ...incident,
              occurredAt: receipt.observedAt,
            },
            EVENT_NAMES.NODE_RELIABILITY_TRANSITION
          );
        }
        log.info({
          event: "feature.node_reliability.watchdog.complete",
          observedAt: receipt.observedAt,
          heartbeatExpiresAt: receipt.heartbeatExpiresAt,
          transitions: receipt.transitions.length,
        });
      }
    } catch (error) {
      lastTickAt = null;
      log.error({ event: "feature.node_reliability.watchdog.failed", error });
    } finally {
      running = false;
    }
  }
  // Startup enforcement finishes before this pod advertises healthy liveness.
  await tick();
  const server = createServer((request, response) => {
    if (!["/healthz", "/readyz"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    const ready =
      !stopping && lastTickAt !== null && Date.now() - lastTickAt <= 15_000;
    response
      .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          ready,
          buildSha: input.buildSha,
          lastTickAt,
        })
      );
  });
  server.listen(8082);
  const interval = setInterval(() => void tick(), 5_000);
  async function stop(): Promise<void> {
    stopping = true;
    clearInterval(interval);
    server.close();
    await Promise.all([sql.close(), ...cells.map((cell) => cell.sql.close())]);
  }
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await new Promise<never>(() => undefined);
  throw new Error("database_recovery_watchdog_exited");
}
