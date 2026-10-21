// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/services/syncGovernanceSchedules`
 * Purpose: Sync governance schedules from config to Temporal. Pure orchestration — depends only on ports and types.
 * Scope: Creates/updates/resumes Temporal schedules for each charter in governance config; pauses schedules removed from config. For NON-operator routable nodes, routes LEDGER_INGEST charters to a per-node NodeTaskWorkflow dispatch (`/api/internal/attribution/collect`) that runs the collect pass IN the owning node on its own ledger DB. For the OPERATOR node it preserves the live single-tenant CollectEpochWorkflow path byte-for-byte. Does not manage tenant-facing schedule CRUD or workflow execution.
 * Invariants:
 *   - OVERLAP_SKIP_DEFAULT: All governance schedules use overlap=SKIP (enforced by ScheduleControlPort)
 *   - CATCHUP_WINDOW_ZERO: No backfill (enforced by ScheduleControlPort)
 *   - PRUNE_IS_PAUSE: Removed schedules are paused, never deleted (reversible)
 *   - SYSTEM_OPS_ONLY: This function runs at deploy time, never exposed as an API endpoint
 *   - PURE_ORCHESTRATION: No adapters, no Temporal client — only ports/types/callbacks
 *   - SYSTEM_TENANT_IS_TENANT: Governance schedules are first-class DB rows owned by system principal
 *   - UPDATE_ON_DRIFT: Existing schedules are updated in-place when config changes (model, cron, timezone, input)
 *   - MULTI_NODE_SCHEDULE_ID: for NON-operator nodes, schedule ids are node-scoped
 *     (`governance:{nodeId}:{charter}`) so an operator loop over N nodes never clobbers a sibling
 *     (last-writer-wins) — see {@link governanceScheduleId}.
 *   - OPERATOR_STAYS_ON_COLLECT_EPOCH (story.5001 REGRESSION_BAR): when `deps.isOperatorNode` is true,
 *     LEDGER_INGEST resolves to the operator's live behavior EXACTLY — the FLAT `governance:ledger_ingest`
 *     schedule id, `CollectEpochWorkflow` on the `ledger-tasks` queue, and the LedgerIngestRunV1 envelope.
 *     It is NOT rewired onto NodeTaskWorkflow(/collect), so there is no dead 404 (before #1953) and no
 *     latent double-collect (after #1953). The dispatch swap is other-nodes-only.
 *   - LEDGER_INGEST_IS_DISPATCH: for a NON-operator node, LEDGER_INGEST does NOT run CollectEpochWorkflow;
 *     it schedules a NodeTaskWorkflow that POSTs `/api/internal/attribution/collect` INTO the owning node,
 *     which runs the collect pass on ITS OWN ledger DB. The node-task grant scope binds the dispatch to
 *     that node (M1). (story.5001 — multi-node epochs.)
 *   - GRAPH_CRON_DRIFT: for graph charters, a cron change is drift — detected by comparing the cron's next
 *     fire time (injected `nextCronRun`) with the Temporal schedule's next run, since describe returns no cron.
 *   - GRAPH_CHARTER (task.5282): a non-ledger charter that declares `graph` (+ `model`) runs that
 *     catalog graph via GraphRunWorkflow with `{ messages: [entrypoint], modelRef: platform/model }`
 *     on its own `graph:execute:{graph}` grant. A charter WITHOUT `graph` keeps the sandbox:openclaw
 *     input, graph id, and governance grant byte-for-byte; LEDGER_INGEST ignores `graph`.
 * Side-effects: IO (Temporal RPC via ScheduleControlPort, grant creation via ensureGovernanceGrant / ensureNodeCollectGrant)
 * Links: docs/spec/substrate-temporal.md, docs/spec/scheduler.md, docs/spec/governance-council.md, .cogni/repo-spec.yaml
 * @public
 */

import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "type-fest";

import {
  type CreateScheduleParams,
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  type ScheduleControlPort,
  type ScheduleDescription,
} from "../ports/schedule-control.port";
import { nodeTaskScope } from "../scopes";

/** Graph ID for OpenClaw sandbox execution */
const GOVERNANCE_GRAPH_ID = "sandbox:openclaw";

/** Default model for governance agent runs */
// TODO(task.0068): Use default_flash from LiteLLM config metadata instead of hardcoded model
const GOVERNANCE_MODEL = "kimi-k2.5";

/** Workflow type for node http-dispatch tasks (the shared operator worker POSTs into the node). */
const NODE_TASK_WORKFLOW_TYPE = "NodeTaskWorkflow";

/**
 * Workflow type for the OPERATOR's live single-tenant epoch collect. story.5001 keeps the
 * operator on this (NOT NodeTaskWorkflow) so its live `governance:ledger_ingest` schedule is
 * byte-for-byte unchanged — no dead dispatch, no double-collect (REGRESSION_BAR).
 */
const COLLECT_EPOCH_WORKFLOW_TYPE = "CollectEpochWorkflow";

/** Task queue the operator's ledger workflows poll (CollectEpochWorkflow / finalize). */
const LEDGER_TASK_QUEUE = "ledger-tasks";

/** graphId tunnel for the operator's ledger workflows (satisfies the NOT-NULL graphId column). */
const LEDGER_INGEST_GRAPH_ID = "ledger:ingest";

/**
 * The node-relative route a LEDGER_INGEST charter dispatches against. The node's
 * `/api/internal/attribution/collect` route (sibling PR #1953 + node-template #82)
 * runs `runCollectPass` in-process on ITS OWN ledger DB. The POST body is
 * `{ nodeId, asOfIso? }` — we send `{ nodeId }` and let the node default `asOfIso`.
 */
const COLLECT_ROUTE = "/api/internal/attribution/collect";

/**
 * Provider key for platform (LiteLLM) models in a graph-run `modelRef` — the same
 * key the schedules UI and pr-review use for platform model ids.
 */
const PLATFORM_PROVIDER_KEY = "platform";

/** Minimal governance schedule shape (no @/ imports — pure type) */
export interface GovernanceScheduleEntry {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
  /**
   * Optional namespaced catalog graph id (e.g. `langgraph:work-prioritizer`). When set,
   * the charter runs THAT graph via GraphRunWorkflow with a graph-run input
   * (`messages` + `modelRef`). Absent → `sandbox:openclaw`, byte-for-byte unchanged.
   * Ignored for LEDGER_INGEST.
   */
  graph?: string;
  /** Platform model id for the `graph` run. Required when `graph` is set. */
  model?: string;
  /**
   * Trusted payload for the `graph` run (e.g. `{ workPrioritization }`, resolved from a
   * repo-spec policy block). Appended to the entrypoint message as a fenced json block.
   */
  payload?: object;
}

/**
 * The graph-run user message: the entrypoint, plus the trusted payload as a fenced json
 * block when present. Without a payload it is exactly the entrypoint (back-compat).
 */
export function governanceGraphMessage(
  entrypoint: string,
  payload: object | undefined
): string {
  return payload === undefined
    ? entrypoint
    : `${entrypoint}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

/** Ledger config for LEDGER_INGEST schedules */
export interface LedgerScheduleConfig {
  /** Stable opaque scope UUID */
  scopeId: string;
  /** Human-friendly scope slug */
  scopeKey: string;
  /** Epoch length in days */
  epochLengthDays: number;
  /** Map of source name → source config */
  activitySources: Record<
    string,
    {
      attributionPipeline: string;
      sourceRefs: string[];
    }
  >;
  /** Pool budget: base_issuance_credits as string (bigint serialized). */
  baseIssuanceCredits?: string;
  /** EVM approver addresses for epoch close. */
  approvers?: string[];
}

/** Minimal governance config shape (no @/ imports — pure type) */
export interface GovernanceScheduleConfig {
  schedules: GovernanceScheduleEntry[];
  /** Ledger config — required when LEDGER_INGEST charter is present */
  ledger?: LedgerScheduleConfig;
}

/** Logger interface matching pino shape */
interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Parameters for upserting a governance schedule DB row */
export interface UpsertGovernanceScheduleRowParams {
  /** Temporal schedule ID (e.g., "governance:community") */
  temporalScheduleId: string;
  /** System tenant user ID */
  ownerUserId: string;
  /** Execution grant ID for authorization */
  executionGrantId: string;
  /** Graph ID (e.g., "sandbox:openclaw") */
  graphId: string;
  /** Graph input payload */
  input: JsonValue;
  /** Cron expression */
  cron: string;
  /** IANA timezone */
  timezone: string;
}

/** Injectable dependencies for governance schedule sync */
export interface GovernanceScheduleSyncDeps {
  /** Idempotent: ensures governance grant exists, returns grantId */
  ensureGovernanceGrant(): Promise<string>;
  /**
   * Idempotent: ensures a node-task-dispatch grant exists for `scope`, returns grantId.
   * scope = `task:dispatch:{nodeId}:{route}` (minted via {@link nodeTaskScope}). Used only
   * for the LEDGER_INGEST → NodeTaskWorkflow(/collect) dispatch; a governance-agent charter
   * still uses {@link GovernanceScheduleSyncDeps.ensureGovernanceGrant}.
   */
  ensureNodeCollectGrant(scope: string): Promise<string>;
  /**
   * Idempotent: ensures a grant scoped `graph:execute:{graphId}` exists for the system
   * principal, returns grantId. Used only for charters that declare `graph` — the
   * sandbox governance grant (and therefore every pre-existing schedule, LEDGER_INGEST
   * included) is untouched. Absent → graph charters are skipped with a warning (a run
   * on the sandbox-scoped grant would 403 at the graph-run route's scope check).
   */
  ensureGraphGrant?(graphId: string): Promise<string>;
  /**
   * GRAPH_CRON_DRIFT: the next fire time (ISO, minute precision) the given cron yields from now in
   * `timezone`. Temporal compiles crons to calendars (describe returns cron=null), so a cron change on
   * a graph charter is detected by comparing this to the schedule's own next run. Absent → no cron
   * drift detection (pre-existing behavior).
   */
  nextCronRun?(cron: string, timezone: string): string | null;
  /**
   * OPERATOR_STAYS_ON_COLLECT_EPOCH (story.5001 REGRESSION_BAR): true only for the operator's
   * OWN node. When true, LEDGER_INGEST resolves to the operator's live single-tenant behavior —
   * the FLAT `governance:ledger_ingest` id running `CollectEpochWorkflow` on the `ledger-tasks`
   * queue with the LedgerIngestRunV1 envelope — instead of the NodeTaskWorkflow(/collect) dispatch
   * every OTHER routable node gets. This keeps the operator's live epoch untouched (no dead 404
   * before the node `/collect` route ships, no latent double-collect after). Non-ledger charters
   * are unaffected by this flag.
   */
  isOperatorNode?: boolean;
  /** Upsert governance schedule row in DB, returns dbScheduleId (UUID) */
  upsertGovernanceScheduleRow(
    params: UpsertGovernanceScheduleRowParams
  ): Promise<string>;
  /** System tenant user ID (owner of governance schedules) */
  systemUserId: string;
  /** Node ID from repo-spec (routes execution to correct node) */
  nodeId: string;
  /** Temporal schedule lifecycle control */
  scheduleControl: ScheduleControlPort;
  /** Returns all Temporal schedule IDs with 'governance:' prefix */
  listGovernanceScheduleIds(): Promise<string[]>;
  /** Disable a governance schedule (DB + Temporal) by its Temporal schedule ID */
  disableSchedule(temporalScheduleId: string): Promise<void>;
  /** Structured logger */
  log: SyncLogger;
}

/** Result of a governance schedule sync operation */
export interface GovernanceScheduleSyncResult {
  created: string[];
  updated: string[];
  resumed: string[];
  skipped: string[];
  paused: string[];
}

/**
 * Derives the Temporal schedule ID from an owning node + charter name.
 * Format: `governance:{nodeId}:{charter_lowercase}`.
 *
 * MULTI_NODE_SCHEDULE_ID: the schedule ID MUST be node-scoped. Without the
 * `{nodeId}` segment every node's `LEDGER_INGEST` charter collapses onto the same
 * Temporal schedule ID (`governance:ledger_ingest`), so an operator loop over N
 * nodes clobbers all but the last (last-writer-wins) and only one node ever
 * collects. Mirrors `nodeScheduleId` (`node-task:{nodeId}:{id}`) in
 * syncNodeSchedules — same cross-tenant isolation rule for governance charters.
 */
export function governanceScheduleId(nodeId: string, charter: string): string {
  return `governance:${nodeId}:${charter.toLowerCase()}`;
}

/**
 * The FLAT (pre-multi-node) schedule ID: `governance:{charter}`. Used ONLY for the
 * operator node so its live single-tenant schedules (`governance:ledger_ingest`
 * CollectEpochWorkflow) are matched/updated in place, never forked into a new
 * node-scoped ghost (OPERATOR_STAYS_ON_COLLECT_EPOCH, story.5001 REGRESSION_BAR).
 */
export function legacyGovernanceScheduleId(charter: string): string {
  return `governance:${charter.toLowerCase()}`;
}

/** Per-node prune prefix — pairs with {@link governanceScheduleId}. A node's sync
 * prunes only ITS OWN schedules, never a sibling node's. */
export function governancePrunePrefix(nodeId: string): string {
  return `governance:${nodeId}:`;
}

/**
 * True for a legacy pre-multi-node schedule ID (`governance:{charter}`, two
 * colon-segments, no `{nodeId}`). This IS the operator's live form: with
 * `isOperatorNode=true` the operator writes/updates its `governance:ledger_ingest`
 * CollectEpochWorkflow schedule on exactly this flat id (OPERATOR_STAYS_ON_COLLECT_EPOCH,
 * story.5001). Non-operator nodes never produce or prune it. Exposed for observability.
 */
export function isLegacyGovernanceScheduleId(scheduleId: string): boolean {
  return (
    scheduleId.startsWith("governance:") && scheduleId.split(":").length === 2
  );
}

/**
 * Checks whether the desired schedule config differs from the current Temporal state.
 * NOTE: cron comparison is skipped when desc.cron is null (Temporal compiles crons
 * to calendars, so the original string isn't available). Input + timezone cover
 * the critical drift cases (model, entrypoint, timezone changes).
 */
function scheduleConfigChanged(
  desc: ScheduleDescription,
  _cron: string,
  timezone: string,
  input: JsonValue,
  desiredTaskQueue: string | undefined
): boolean {
  // bug.5023: a queue migration (e.g. shared `ledger-tasks` → per-node
  // `ledger-tasks-<nodeId>`) must count as drift, or the schedule keeps firing on the
  // old, now-unpolled queue. Only compare when we asked for a specific queue AND the
  // adapter could read the current one (older adapters/mocks omit it → skip, no false drift).
  const taskQueueChanged =
    desiredTaskQueue !== undefined &&
    typeof desc.taskQueue === "string" &&
    desc.taskQueue !== desiredTaskQueue;
  return (
    (desc.timezone !== null && desc.timezone !== timezone) ||
    !isDeepStrictEqual(desc.input, input) ||
    taskQueueChanged
  );
}

/**
 * Syncs governance schedules from repo-spec config to Temporal.
 *
 * For each schedule in config:
 * - If missing in Temporal: create
 * - If exists with changed config: update in-place
 * - If exists but paused (same config): resume
 * - If exists but paused (changed config): update + resume
 * - If exists, running, same config: skip (no-op)
 *
 * For governance schedules in Temporal but not in config:
 * - Pause (don't delete — reversible)
 *
 * @param config - Governance config from repo-spec
 * @param deps - Injectable dependencies
 * @returns Summary of actions taken
 */
export async function syncGovernanceSchedules(
  config: GovernanceScheduleConfig,
  deps: GovernanceScheduleSyncDeps
): Promise<GovernanceScheduleSyncResult> {
  const { scheduleControl, log } = deps;

  // 1. Ensure the governance-agent grant exists for cogni_system (used by non-ledger
  //    charters). The LEDGER_INGEST → NodeTaskWorkflow dispatch mints its OWN
  //    node-task-scoped grant below (per-node, M1-bound).
  const governanceGrantId = await deps.ensureGovernanceGrant();
  log.info({ grantId: governanceGrantId }, "Governance grant ready");

  // 2. Create, update, or resume schedules from config
  const result: GovernanceScheduleSyncResult = {
    created: [],
    updated: [],
    resumed: [],
    skipped: [],
    paused: [],
  };

  const configScheduleIds = new Set<string>();

  // OPERATOR_STAYS_ON_COLLECT_EPOCH: the operator's ids stay on the FLAT legacy form
  // (`governance:{charter}`) so its live `governance:ledger_ingest` CollectEpochWorkflow
  // schedule is matched/updated in place (never a NEW node-scoped ghost). Every other
  // routable node uses the node-scoped id (MULTI_NODE_SCHEDULE_ID).
  const isOperator = deps.isOperatorNode === true;

  for (const schedule of config.schedules) {
    const scheduleId = isOperator
      ? legacyGovernanceScheduleId(schedule.charter)
      : governanceScheduleId(deps.nodeId, schedule.charter);
    configScheduleIds.add(scheduleId);

    // Determine if this is a LEDGER_INGEST (epoch-collect) schedule.
    const isLedgerIngest = schedule.charter.toUpperCase() === "LEDGER_INGEST";

    let desiredInput: JsonValue;
    let workflowType: string | undefined;
    let taskQueueOverride: string | undefined;
    let graphId: string;
    let grantId: string;

    if (isLedgerIngest && isOperator && config.ledger) {
      // OPERATOR_STAYS_ON_COLLECT_EPOCH (story.5001 REGRESSION_BAR): the operator keeps its
      // live single-tenant epoch EXACTLY — CollectEpochWorkflow on the `ledger-tasks` queue,
      // the LedgerIngestRunV1 envelope, the `ledger:ingest` graphId, the governance grant. It
      // is NOT rewired onto NodeTaskWorkflow(/collect): that would dead-dispatch (the operator's
      // `/api/internal/attribution/collect` route ships in a sibling PR) AND, once it lands,
      // double-collect alongside this schedule. The dispatch swap below is other-nodes-only.
      desiredInput = {
        version: 1,
        scopeId: config.ledger.scopeId,
        scopeKey: config.ledger.scopeKey,
        epochLengthDays: config.ledger.epochLengthDays,
        activitySources: config.ledger.activitySources,
        ...(config.ledger.baseIssuanceCredits && {
          baseIssuanceCredits: config.ledger.baseIssuanceCredits,
        }),
        ...(config.ledger.approvers &&
          config.ledger.approvers.length > 0 && {
            approvers: config.ledger.approvers,
          }),
      };
      workflowType = COLLECT_EPOCH_WORKFLOW_TYPE;
      // bug.5023: the shared `ledger-tasks` queue is purged — the operator's
      // CollectEpochWorkflow runs on its OWN per-node queue, matching the per-node
      // ledger worker (ledger-worker.ts) and the finalize dispatch (finalize route).
      taskQueueOverride = `${LEDGER_TASK_QUEUE}-${deps.nodeId}`;
      graphId = LEDGER_INGEST_GRAPH_ID;
      grantId = governanceGrantId;
    } else if (isLedgerIngest && !isOperator) {
      // LEDGER_INGEST_IS_DISPATCH (story.5001): schedule a NodeTaskWorkflow that
      // POSTs `/api/internal/attribution/collect` INTO the owning node, which runs
      // the collect pass on ITS OWN ledger DB. We do NOT run CollectEpochWorkflow on
      // the operator's single-DB worker. The `/collect` body is `{ nodeId, asOfIso? }`;
      // the node defaults `asOfIso`, so the dispatched payload is just `{ nodeId }`.
      const scope = nodeTaskScope(deps.nodeId, COLLECT_ROUTE);
      grantId = await deps.ensureNodeCollectGrant(scope);
      // NodeTaskWorkflow envelope: the adapter (`buildWorkflowArgs`) reads
      // `input.route` + `input.payload` and unwraps them into the NodeTaskInput
      // ({ nodeId, route, payload }). `workflowType` selects NodeTaskWorkflow; the
      // `task:{route}` graphId tunnel satisfies the NOT-NULL graphId column and is
      // the adapter's route fallback (mirrors syncNodeSchedules http-dispatch).
      desiredInput = {
        route: COLLECT_ROUTE,
        payload: { nodeId: deps.nodeId },
      };
      workflowType = NODE_TASK_WORKFLOW_TYPE;
      graphId = `task:${COLLECT_ROUTE}`;
    } else if (schedule.graph !== undefined) {
      // GRAPH_CHARTER (task.5282): run the declared catalog graph through the default
      // GraphRunWorkflow. The input mirrors a user-created graph schedule — the
      // entrypoint as the single user message plus an explicit platform `modelRef`
      // (the internal graph-run route requires `modelRef`; there is no model default).
      if (schedule.model === undefined || deps.ensureGraphGrant === undefined) {
        log.warn(
          {
            scheduleId,
            graph: schedule.graph,
            hasModel: schedule.model !== undefined,
            hasGraphGrant: deps.ensureGraphGrant !== undefined,
          },
          "Skipping governance graph schedule: model or graph grant unavailable"
        );
        // Not added to the live set below → an existing copy is paused by the prune
        // step instead of firing runs that would fail the route's validation.
        configScheduleIds.delete(scheduleId);
        result.skipped.push(scheduleId);
        continue;
      }
      desiredInput = {
        messages: [
          {
            role: "user",
            content: governanceGraphMessage(
              schedule.entrypoint,
              schedule.payload
            ),
          },
        ],
        modelRef: {
          providerKey: PLATFORM_PROVIDER_KEY,
          modelId: schedule.model,
        },
      };
      graphId = schedule.graph;
      grantId = await deps.ensureGraphGrant(schedule.graph);
    } else {
      desiredInput = {
        message: schedule.entrypoint,
        model: GOVERNANCE_MODEL,
      };
      graphId = GOVERNANCE_GRAPH_ID;
      grantId = governanceGrantId;
    }

    // Upsert DB row first — governance schedules are first-class DB rows
    const dbScheduleId = await deps.upsertGovernanceScheduleRow({
      temporalScheduleId: scheduleId,
      ownerUserId: deps.systemUserId,
      executionGrantId: grantId,
      graphId,
      input: desiredInput,
      cron: schedule.cron,
      timezone: schedule.timezone,
    });

    const desiredParams: CreateScheduleParams = {
      scheduleId,
      nodeId: deps.nodeId,
      dbScheduleId,
      ownerUserId: deps.systemUserId,
      cron: schedule.cron,
      timezone: schedule.timezone,
      graphId,
      executionGrantId: grantId,
      input: desiredInput,
      overlapPolicy: "skip",
      catchupWindowMs: 0,
      // NON-operator LEDGER_INGEST ⇒ NodeTaskWorkflow (dispatch INTO the node);
      // operator LEDGER_INGEST ⇒ CollectEpochWorkflow; undefined ⇒ GraphRunWorkflow
      // (adapter default) for governance-agent charters — sandbox or declared `graph`.
      workflowType,
      // Operator's CollectEpochWorkflow polls the `ledger-tasks` queue; undefined
      // for everything else (shared operator worker + its default queue).
      taskQueueOverride,
    };

    try {
      await scheduleControl.createSchedule(desiredParams);
      result.created.push(scheduleId);
      log.info(
        { scheduleId, cron: schedule.cron },
        "Created governance schedule"
      );
    } catch (error) {
      if (isScheduleControlConflictError(error)) {
        // Schedule already exists — check for config or link drift
        const desc = await scheduleControl.describeSchedule(scheduleId);
        if (!desc) {
          // Race condition: schedule disappeared between create and describe
          result.skipped.push(scheduleId);
          continue;
        }

        const configChanged = scheduleConfigChanged(
          desc,
          schedule.cron,
          schedule.timezone,
          desiredInput,
          taskQueueOverride
        );
        const linkDrift = desc.dbScheduleId !== dbScheduleId;
        // GRAPH_CRON_DRIFT (graph charters only — the ledger schedule stays byte-for-byte): a cron
        // change must reach Temporal even though describe cannot return the stored cron.
        const desiredNext =
          schedule.graph !== undefined && !isLedgerIngest && !desc.isPaused
            ? (deps.nextCronRun?.(schedule.cron, schedule.timezone) ?? null)
            : null;
        const cronDrift =
          desiredNext !== null &&
          desc.nextRunAtIso !== null &&
          desiredNext.slice(0, 16) !== desc.nextRunAtIso.slice(0, 16);

        if (configChanged || linkDrift || cronDrift) {
          await scheduleControl.updateSchedule(scheduleId, desiredParams);
          if (desc.isPaused) {
            await scheduleControl.resumeSchedule(scheduleId);
          }
          result.updated.push(scheduleId);
          log.info(
            { scheduleId, configChanged, linkDrift, cronDrift },
            "Updated governance schedule (drift detected)"
          );
        } else if (desc.isPaused) {
          await scheduleControl.resumeSchedule(scheduleId);
          result.resumed.push(scheduleId);
          log.info({ scheduleId }, "Resumed governance schedule");
        } else {
          result.skipped.push(scheduleId);
          log.info({ scheduleId }, "Governance schedule up to date, skipping");
        }
      } else {
        throw error;
      }
    }
  }

  // 3. Prune: pause governance schedules not in current config
  const allGovernanceIds = await deps.listGovernanceScheduleIds();
  for (const existingId of allGovernanceIds) {
    if (!configScheduleIds.has(existingId)) {
      try {
        await scheduleControl.pauseSchedule(existingId);
        await deps.disableSchedule(existingId);
        result.paused.push(existingId);
        log.warn(
          { scheduleId: existingId },
          "Paused governance schedule (removed from repo-spec)"
        );
      } catch (error) {
        if (isScheduleControlNotFoundError(error)) {
          // Schedule was deleted externally — nothing to pause
          log.warn(
            { scheduleId: existingId },
            "Governance schedule not found in Temporal (deleted externally)"
          );
        } else {
          throw error;
        }
      }
    }
  }

  return result;
}
