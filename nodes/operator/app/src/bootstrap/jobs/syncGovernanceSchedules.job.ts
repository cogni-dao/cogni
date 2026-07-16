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
import {
  governancePrunePrefix,
  isLegacyGovernanceScheduleId,
  syncGovernanceSchedules,
} from "@cogni/scheduler-core";
import cronParser from "cron-parser";
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import {
  getContainer,
  resolveRoutableNodeGovernanceConfigs,
} from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { schedules } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server-env";

const GOVERNANCE_GRANT_SCOPES = ["graph:execute:sandbox:openclaw"] as const;

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
    const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);

    // Pause a schedule DB row. The Temporal pause is handled by the sync service's
    // prune step (or, for legacy ids, the explicit pauseSchedule below).
    const disableSchedule = async (
      temporalScheduleId: string
    ): Promise<void> => {
      await serviceDb
        .update(schedules)
        .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            eq(schedules.temporalScheduleId, temporalScheduleId)
          )
        );
    };

    // Sync ONE node's governance schedules. Deps are identical across nodes except
    // `nodeId` + the prune scope (MULTI_NODE_SCHEDULE_ID): a node prunes only its
    // own `governance:{nodeId}:` schedules, never a sibling node's.
    const syncFor = (
      nodeId: string,
      cfg: Parameters<typeof syncGovernanceSchedules>[0]
    ) =>
      syncGovernanceSchedules(cfg, {
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
        nodeId,
        scheduleControl: container.scheduleControl,
        // MULTI_NODE_SCHEDULE_ID: prune scoped to THIS node only.
        listGovernanceScheduleIds: () =>
          container.scheduleControl.listScheduleIds(
            governancePrunePrefix(nodeId)
          ),
        disableSchedule,
        log,
      });

    const totals = {
      created: 0,
      updated: 0,
      resumed: 0,
      skipped: 0,
      paused: 0,
    };
    const add = (
      r: Awaited<ReturnType<typeof syncGovernanceSchedules>>
    ): void => {
      totals.created += r.created.length;
      totals.updated += r.updated.length;
      totals.resumed += r.resumed.length;
      totals.skipped += r.skipped.length;
      totals.paused += r.paused.length;
    };

    // 1) Operator's OWN governance (from its mounted repo-spec).
    const operatorNodeId = getNodeId();
    add(await syncFor(operatorNodeId, getGovernanceConfig()));

    // 2) Every OTHER routable node — read its git-authoritative governance config
    //    and sync its collect schedule. THIS is what gives spawned nodes epochs
    //    (previously the operator scheduled only its own — single-tenant).
    const nodeConfigs = await resolveRoutableNodeGovernanceConfigs();
    for (const { nodeId, slug, config } of nodeConfigs) {
      if (nodeId === operatorNodeId) continue; // already handled above
      try {
        add(await syncFor(nodeId, config));
      } catch (err) {
        log.warn(
          {
            event: "governance.node_sync_failed",
            nodeId,
            slug,
            err: String(err),
          },
          "governance sync failed for a routable node — continuing with the rest"
        );
      }
    }

    // 3) One-time legacy prune: pause any pre-multi-node flat `governance:{charter}`
    //    schedule so the operator's collection never runs twice (old + new id).
    const legacyIds = (
      await container.scheduleControl.listScheduleIds("governance:")
    ).filter(isLegacyGovernanceScheduleId);
    for (const legacyId of legacyIds) {
      try {
        await container.scheduleControl.pauseSchedule(legacyId);
        await disableSchedule(legacyId);
        totals.paused += 1;
        log.warn(
          { scheduleId: legacyId },
          "paused legacy (pre-multi-node) governance schedule"
        );
      } catch (err) {
        log.warn(
          { scheduleId: legacyId, err: String(err) },
          "failed to pause legacy governance schedule (continuing)"
        );
      }
    }

    log.info(totals, "Governance schedule sync complete (multi-node)");
    return totals;
  } finally {
    // Release advisory lock on the same connection that acquired it
    await reservedConn`SELECT pg_advisory_unlock(hashtext('governance_sync'))`;
    reservedConn.release();
  }
}
