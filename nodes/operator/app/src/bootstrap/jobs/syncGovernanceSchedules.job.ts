// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncGovernanceSchedules.job`
 * Purpose: Job module that wires governance schedule sync to the application container.
 * Scope: Syncs own governance and foreign Ledger dispatch under an advisory lock; does not contain business logic (scheduler-core owns orchestration).
 * Invariants:
 *   - SINGLE_WRITER: pg_advisory_lock on a reserved (pinned) pool connection prevents concurrent sync runs
 *   - GRANT_VIA_PORT: Uses ensureGrant on ExecutionGrantUserPort, no raw SQL
 *   - SYSTEM_PRINCIPAL: Grant created for COGNI_SYSTEM_PRINCIPAL_USER_ID
 *   - FOREIGN_LEDGER_ONLY: foreign desired writes and prune candidates contain only the exact
 *     node-scoped Ledger dispatch; sovereign mission/graph schedules remain node-owned.
 *     The operator syncs its own FLAT `governance:{charter}` schedules.
 *   - OPERATOR_STAYS_ON_COLLECT_EPOCH (story.5001 REGRESSION_BAR): step 1 syncs the operator with
 *     `isOperator=true`, so its LEDGER_INGEST stays on the live FLAT `governance:ledger_ingest`
 *     CollectEpochWorkflow schedule (`ledger-tasks` queue) — byte-for-byte unchanged, NOT rewired
 *     onto NodeTaskWorkflow(/collect). The dispatch swap is other-nodes-only (step 2), so there is
 *     no dead 404 (before the operator `/collect` route ships) and no latent double-collect (after).
 *   - SELF_SCOPE_NEEDS_NO_REGISTRY (task.5282): scope "self" runs ONLY step 1 — the operator's own
 *     charters from its image repo-spec — under the same advisory lock, and never reads the fleet
 *     registry / routable-node configs. Boot uses it so the operator's own schedules activate even
 *     while catalog projection is failing. Scope "all" (default; ops route) is today's behavior.
 * Side-effects: IO (database advisory lock, Temporal RPC, grant creation)
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts,
 *   nodes/operator/app/src/bootstrap/jobs/resolveRoutableNodeGovernanceConfigs.ts,
 *   docs/spec/substrate-temporal.md, docs/spec/governance-scheduling.md
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import {
  governancePrunePrefix,
  governanceScheduleId,
  isLegacyGovernanceScheduleId,
  syncGovernanceSchedules,
} from "@cogni/scheduler-core";
import cronParser from "cron-parser";
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { resolveRoutableNodeGovernanceConfigs } from "@/bootstrap/jobs/resolveRoutableNodeGovernanceConfigs";
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

/** "self" = the operator's own charters only; "all" = own charters + every routable node. */
export type GovernanceSyncScope = "self" | "all";

export interface GovernanceSyncJobOptions {
  /** Default "all" (unchanged behavior). */
  readonly scope?: GovernanceSyncScope;
  /**
   * Throw instead of returning a no-op summary when another sync holds the advisory lock.
   * Boot retry loops set this so a kick that lost the lock race is retried, not dropped.
   */
  readonly throwIfLocked?: boolean;
}

/** Thrown (only with `throwIfLocked`) when another governance sync holds the lock. */
export class GovernanceSyncLockedError extends Error {
  constructor() {
    super("governance sync already running (advisory lock held)");
    this.name = "GovernanceSyncLockedError";
  }
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
export async function runGovernanceSchedulesSyncJob(
  options: GovernanceSyncJobOptions = {}
): Promise<GovernanceScheduleSyncSummary> {
  const scope: GovernanceSyncScope = options.scope ?? "all";
  const container = getContainer();
  const { log } = container;

  // Skip if governance schedules disabled (e.g., in preview environments)
  if (!serverEnv().GOVERNANCE_SCHEDULES_ENABLED) {
    log.info({}, "Governance schedules disabled, skipping sync");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  log.info({ scope }, "Starting governance schedule sync job");

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
    if (options.throwIfLocked) throw new GovernanceSyncLockedError();
    log.info({}, "Governance sync already running, skipping");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  try {
    const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);

    // Pause a schedule DB row (Temporal pause is handled by the sync service's prune step).
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

    // Sync own flat charters or a foreign node's operator-owned Ledger dispatch.
    // Foreign sovereign charters stay outside both desired writes and prune ownership.
    //
    // `isOperator` (OPERATOR_STAYS_ON_COLLECT_EPOCH, story.5001 REGRESSION_BAR): true ONLY for
    // the operator's own node (step 1). It keeps the operator's LEDGER_INGEST on the live FLAT
    // `governance:ledger_ingest` CollectEpochWorkflow schedule (`ledger-tasks` queue), instead of
    // rewiring it onto the NodeTaskWorkflow(/collect) dispatch every OTHER routable node gets —
    // so the operator's live epoch is byte-for-byte unchanged (no dead 404, no double-collect).
    const syncFor = (
      nodeId: string,
      cfg: Parameters<typeof syncGovernanceSchedules>[0],
      isOperator: boolean
    ) =>
      syncGovernanceSchedules(cfg, {
        isOperatorNode: isOperator,
        ensureGovernanceGrant: async () => {
          const grant = await container.executionGrantPort.ensureGrant({
            userId: systemUserId,
            billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
            scopes: GOVERNANCE_GRANT_SCOPES,
          });
          return grant.id;
        },
        // LEDGER_INGEST → NodeTaskWorkflow(/collect): mint the node-task-dispatch grant
        // (`task:dispatch:{nodeId}:/api/internal/attribution/collect`) so the shared operator
        // worker is authorized to POST into THIS node (M1 grant↔node binding, structural).
        ensureNodeCollectGrant: async (scope: string) => {
          const grant = await container.executionGrantPort.ensureGrant({
            userId: systemUserId,
            billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
            scopes: [scope],
          });
          return grant.id;
        },
        // GRAPH_CHARTER (task.5282): a charter that declares `graph` runs on its own
        // `graph:execute:{graphId}` grant, so the sandbox governance grant (and the
        // LEDGER_INGEST schedule that shares it) is untouched.
        ensureGraphGrant: async (graphId: string) => {
          const grant = await container.executionGrantPort.ensureGrant({
            userId: systemUserId,
            billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
            scopes: [`graph:execute:${graphId}`],
          });
          return grant.id;
        },
        // GRAPH_CRON_DRIFT: next fire time of a cron, minute precision, for drift detection.
        nextCronRun: (cron: string, timezone: string) => {
          try {
            return computeNextRun(cron, timezone).toISOString();
          } catch {
            return null;
          }
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
        nodeId,
        scheduleControl: container.scheduleControl,
        // Prune scope:
        //  - Foreign node → only the exact operator-owned Ledger dispatch.
        //    Sovereign mission/graph schedules belong to that node's startup; even a
        //    removed foreign declaration must never make them prune candidates.
        //  - operator (isOperator) → its own FLAT `governance:{charter}` schedules only. It
        //    lists the bare `governance:` prefix (pre-swap behavior) then filters to the flat
        //    (legacy, 2-segment) ids, so it prunes a removed operator charter WITHOUT ever
        //    pausing another node's node-scoped dispatch schedule (OPERATOR_STAYS_ON_COLLECT_EPOCH).
        listGovernanceScheduleIds: isOperator
          ? async () => {
              const all =
                await container.scheduleControl.listScheduleIds("governance:");
              return all.filter(isLegacyGovernanceScheduleId);
            }
          : async () => {
              const all = await container.scheduleControl.listScheduleIds(
                governancePrunePrefix(nodeId)
              );
              const collectSid = governanceScheduleId(nodeId, "LEDGER_INGEST");
              return all.filter((id) => id === collectSid);
            },
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

    // 1) Operator's OWN governance (from its mounted repo-spec), synced as the OPERATOR
    //    (isOperator=true → OPERATOR_STAYS_ON_COLLECT_EPOCH). Its LEDGER_INGEST resolves to the
    //    live single-tenant epoch EXACTLY: the FLAT `governance:ledger_ingest` schedule running
    //    CollectEpochWorkflow on the `ledger-tasks` queue. It is NOT rewired onto
    //    NodeTaskWorkflow(/collect) — that swap is other-nodes-only (step 2).
    //
    //    REGRESSION_BAR (story.5001): because the operator's ids stay FLAT, its live
    //    `governance:ledger_ingest` schedule is matched/updated in place (never forked into a
    //    node-scoped ghost), and its node-scoped prune prefix never lists the flat id. So the
    //    operator's live epoch is byte-for-byte unchanged: no dead 404 before the sibling
    //    `/api/internal/attribution/collect` route ships, no latent double-collect after.
    const operatorNodeId = getNodeId();
    add(await syncFor(operatorNodeId, getGovernanceConfig(), true));

    // SELF_SCOPE_NEEDS_NO_REGISTRY: the operator's own charters need no GitHub/catalog read.
    if (scope === "self") {
      log.info(totals, "Governance schedule sync complete (self)");
      return totals;
    }

    // 2) Every OTHER routable node — read its git-authoritative governance config and sync its
    //    epoch-collect NodeTaskWorkflow(/collect) dispatch. THIS is what gives spawned nodes
    //    multi-node epochs (previously the operator scheduled only its own — single-tenant).
    //
    //    OPERATOR_NOT_DOUBLE_COLLECTED: skip the operator's own node — it already collects via
    //    step (1) on its flat CollectEpochWorkflow schedule; a NodeTaskWorkflow(/collect) here
    //    would double-collect it (and dead-dispatch until the operator's `/collect` route ships).
    const nodeConfigs = await resolveRoutableNodeGovernanceConfigs();
    for (const { nodeId, slug, config } of nodeConfigs) {
      if (nodeId === operatorNodeId) continue; // OPERATOR_NOT_DOUBLE_COLLECTED
      try {
        // Foreign graph/mission declarations are reconciled only by sovereign startup.
        // Match the router's case-insensitive Ledger classification.
        const foreignLedgerConfig = {
          ...config,
          schedules: config.schedules.filter(
            ({ charter }) => charter.toUpperCase() === "LEDGER_INGEST"
          ),
        };
        add(await syncFor(nodeId, foreignLedgerConfig, false));

        // DEPLOY_COLLECT: kick each routable node's epoch-collect dispatch once per sync so a
        // node's ledger is populated promptly instead of waiting up to a full cron period. This
        // is idempotent (the node dedups the epoch window — `ensureEpochForWindow`), and it does
        // NOT gate on `lastRunAtIso`: a node whose FIRST dispatch failed (e.g. it wasn't yet on
        // the M2 grant-validate contract) has `lastRunAtIso` set but never actually collected, so
        // a never-run gate would strand it. A node the worker can't reach fail-softs at dispatch.
        const collectSid = governanceScheduleId(nodeId, "LEDGER_INGEST");
        const desc =
          await container.scheduleControl.describeSchedule(collectSid);
        if (desc) {
          await container.scheduleControl.triggerSchedule(collectSid);
          log.info(
            {
              event: "governance.node_collect_kicked",
              nodeId,
              slug,
              scheduleId: collectSid,
            },
            "kicked epoch collect for a routable node"
          );
        }
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

    log.info(totals, "Governance schedule sync complete (multi-node)");
    return totals;
  } finally {
    // Release advisory lock on the same connection that acquired it
    await reservedConn`SELECT pg_advisory_unlock(hashtext('governance_sync'))`;
    reservedConn.release();
  }
}
