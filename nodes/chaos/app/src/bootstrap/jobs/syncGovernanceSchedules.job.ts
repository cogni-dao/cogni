// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncGovernanceSchedules.job`
 * Purpose: Job module that wires governance schedule sync to the application container.
 * Scope: Acquires advisory lock, resolves dependencies from container, and calls syncGovernanceSchedules. Does not contain business logic.
 * Invariants:
 *   - SINGLE_WRITER: pg_advisory_lock on a reserved (pinned) pool connection prevents concurrent sync runs
 *   - GRANT_VIA_PORT: Uses ensureGrant on ExecutionGrantUserPort, no raw SQL
 *   - SYSTEM_PRINCIPAL: Grant created for COGNI_SYSTEM_PRINCIPAL_USER_ID
 * Side-effects: IO (database advisory lock, Temporal RPC, grant creation)
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts, docs/spec/governance-scheduling.md
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { syncGovernanceSchedules } from "@cogni/scheduler-core";
import cronParser from "cron-parser";
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { schedules } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server-env";

const GOVERNANCE_GRANT_SCOPES = ["graph:execute:sandbox:openclaw"] as const;

/** Temporal schedule ID for the ledger-ingest (epoch) schedule. */
const LEDGER_INGEST_SCHEDULE_ID = "governance:ledger_ingest";

function computeNextRun(cron: string, timezone: string): Date {
  const interval = cronParser.parseExpression(cron, {
    currentDate: new Date(),
    tz: timezone,
  });
  return interval.next().toDate();
}

export interface GovernanceScheduleSyncSummary {
  created: number;
  updated: number;
  resumed: number;
  skipped: number;
  paused: number;
}

/**
 * Run the governance schedules sync job.
 *
 * 1. Acquires a PostgreSQL advisory lock (single-writer)
 * 2. Resolves deps from the application container
 * 3. Calls syncGovernanceSchedules with repo-spec config
 */
export async function runGovernanceSchedulesSyncJob(): Promise<GovernanceScheduleSyncSummary> {
  const container = getContainer();
  const { log } = container;

  // Skip if governance schedules disabled (e.g., in preview environments)
  if (!serverEnv().GOVERNANCE_SCHEDULES_ENABLED) {
    log.info({}, "Governance schedules disabled, skipping sync");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  log.info({}, "Starting governance schedule sync job");

  // Advisory lock: non-blocking single-writer guard.
  // Pin a single pool connection so lock + unlock use the same session
  // (session-scoped advisory locks only release on the connection that acquired them).
  const serviceDb = getServiceDb();
  const reservedConn = await serviceDb.$client.reserve();
  const [lockRow] =
    await reservedConn`SELECT pg_try_advisory_lock(hashtext('governance_sync')) AS acquired`;
  const acquired = (lockRow as { acquired: boolean } | undefined)?.acquired;
  if (!acquired) {
    reservedConn.release();
    log.info({}, "Governance sync already running, skipping");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  try {
    const config = getGovernanceConfig();
    const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);

    const result = await syncGovernanceSchedules(config, {
      ensureGovernanceGrant: async () => {
        const grant = await container.executionGrantPort.ensureGrant({
          userId: systemUserId,
          billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
          scopes: GOVERNANCE_GRANT_SCOPES,
        });
        return grant.id;
      },
      upsertGovernanceScheduleRow: async (params) => {
        const nextRunAt = computeNextRun(params.cron, params.timezone);

        // Scope lookup to system tenant to avoid cross-tenant collisions
        const existingRows = await serviceDb
          .select({ id: schedules.id })
          .from(schedules)
          .where(
            and(
              eq(schedules.ownerUserId, params.ownerUserId),
              eq(schedules.temporalScheduleId, params.temporalScheduleId)
            )
          )
          .limit(1);
        const existing = existingRows[0];

        if (existing) {
          await serviceDb
            .update(schedules)
            .set({
              executionGrantId: params.executionGrantId,
              input: params.input,
              cron: params.cron,
              timezone: params.timezone,
              enabled: true,
              nextRunAt,
              updatedAt: new Date(),
            })
            .where(eq(schedules.id, existing.id));
          return existing.id;
        }

        const [row] = await serviceDb
          .insert(schedules)
          .values({
            temporalScheduleId: params.temporalScheduleId,
            ownerUserId: params.ownerUserId,
            executionGrantId: params.executionGrantId,
            graphId: params.graphId,
            input: params.input,
            cron: params.cron,
            timezone: params.timezone,
            enabled: true,
            nextRunAt,
          })
          .returning();
        if (!row) throw new Error("Insert returned no row");
        return row.id;
      },
      systemUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      nodeId: getNodeId(),
      scheduleControl: container.scheduleControl,
      listGovernanceScheduleIds: () =>
        container.scheduleControl.listScheduleIds("governance:"),
      disableSchedule: async (temporalScheduleId: string) => {
        // Direct DB update via serviceDb (same pattern as upsertGovernanceScheduleRow).
        // Cannot use ScheduleUserPort.updateSchedule here because the adapter
        // passes DB UUID to scheduleControl.pauseSchedule() which expects a
        // Temporal schedule ID — causing a rollback. The Temporal pause is
        // already handled by the sync service's prune step.
        await serviceDb
          .update(schedules)
          .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
              eq(schedules.temporalScheduleId, temporalScheduleId)
            )
          );
      },
      log,
    });

    log.info(
      {
        created: result.created.length,
        updated: result.updated.length,
        resumed: result.resumed.length,
        skipped: result.skipped.length,
        paused: result.paused.length,
      },
      "Governance schedule sync complete"
    );

    // Eager first epoch: when the ledger schedule is newly created, trigger one collection
    // run now so epoch 1 opens immediately instead of waiting for the first cron fire.
    // Idempotent: only fires on `created` (steady-state reboots see it skipped); the epoch
    // window-unique constraint also prevents duplicates. Failure is non-fatal — cron backstops.
    if (result.created.includes(LEDGER_INGEST_SCHEDULE_ID)) {
      try {
        await container.scheduleControl.triggerSchedule(
          LEDGER_INGEST_SCHEDULE_ID
        );
        log.info(
          { scheduleId: LEDGER_INGEST_SCHEDULE_ID },
          "Eager-triggered first epoch collection"
        );
      } catch (err) {
        log.warn(
          { scheduleId: LEDGER_INGEST_SCHEDULE_ID, err },
          "Eager epoch trigger failed — cron will open the first epoch"
        );
      }
    }

    return {
      created: result.created.length,
      updated: result.updated.length,
      resumed: result.resumed.length,
      skipped: result.skipped.length,
      paused: result.paused.length,
    };
  } finally {
    // Release advisory lock on the same connection that acquired it
    await reservedConn`SELECT pg_advisory_unlock(hashtext('governance_sync'))`;
    reservedConn.release();
  }
}
