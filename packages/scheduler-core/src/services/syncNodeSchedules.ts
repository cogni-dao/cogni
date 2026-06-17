// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/services/syncNodeSchedules`
 * Purpose: Reconcile a node's declarative `schedules` (repo-spec) into Temporal Schedules under that node's tenant identity. Pure orchestration — depends only on ports + injected callbacks.
 * Scope: Create/update/pause/resume Temporal schedules for each node-declared schedule; pause schedules removed from the spec; teardown (decommission) pauses schedules + revokes grants. Does NOT do tenant-facing schedule CRUD or workflow execution. Mirror of syncGovernanceSchedules for the node-as-tenant path (story.5008 / task.5030).
 * Invariants:
 *   - SYSTEM_OPS_ONLY (CRUD_AUTHORITY): provision/flight/decommission only, not node-callable, single-writer advisory lock.
 *   - NODE_PINNED (M8): nodeId is the repo-spec own node_id, foreign-node schedules rejected.
 *   - WORKFLOWTYPE_FROM_KIND: route to NodeTaskWorkflow, graph to GraphRunWorkflow, no operator target vocab.
 *   - REAL_CRON_DRIFT: cron compared to STORED cron not the Temporal calendar; prune pauses, teardown revokes grants.
 * Side-effects: IO (Temporal RPC via ScheduleControlPort; DB upsert + grant mint/revoke via injected callbacks)
 * Links: docs/spec/temporal-patterns.md (node-as-tenant), docs/spec/node-baas-architecture.md (node→Temporal seam), packages/repo-spec/src/accessors.ts (extractNodeSchedules), docs/design/node-temporal-tenant-interface.md
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

/** Workflow type for node http-dispatch tasks. Owned by T1 (task.5029) — see seam note below. */
const NODE_TASK_WORKFLOW_TYPE = "NodeTaskWorkflow";

/** Default workflow type for graph runs (adapter default when workflowType omitted). */
// graph schedules omit workflowType → adapter routes to GraphRunWorkflow.

/**
 * Node-side mapping of T1's canonical `NodeTaskInput` envelope.
 *
 * SEAM (story.5008): the CANONICAL schema is owned by T1 at
 * `packages/temporal-workflows/src/workflows/node-task.schema.ts`
 * (SINGLE_INPUT_CONTRACT). T1 has not merged at the time of writing, so this is the
 * node-side contract type that MAPS to it. Once T1 lands, replace this with
 * `import type { NodeTaskInput } from "@cogni/temporal-workflows/..."` and parse with
 * T1's `.strict()` zod schema before start — do NOT redefine the canonical schema here.
 *
 * TODO(task.5029 seam): swap to T1's canonical NodeTaskInput once merged.
 */
export interface NodeTaskInputEnvelope {
  /** Schema discriminator — pinned so the producer is greppable when T1's schema lands. */
  readonly kind: "node-task";
  /** Operator-pinned node id (routes dispatch + scopes the grant). */
  readonly nodeId: string;
  /** Stable schedule id (the node-authored `id`). */
  readonly scheduleId: string;
  /** Relative route on the node's own host (http-dispatch target). */
  readonly route: string;
  /** Opaque payload — the node's route owns its meaning. */
  readonly payload: JsonValue;
}

/**
 * Desired node schedule (the reconcile input). Mirrors repo-spec's NodeScheduleConfig
 * but kept as a local pure type (no `@cogni/repo-spec` import — scheduler-core stays
 * dependency-light, same convention as GovernanceScheduleEntry).
 */
export interface NodeScheduleEntry {
  /** Stable schedule id (the node-authored `id`). */
  id: string;
  /** Operator-pinned node id — the repo-spec's own node_id. */
  nodeId: string;
  cron: string;
  timezone: string;
  /** Inferred workflowType selector (route XOR graph). */
  kind: "http-dispatch" | "graph";
  /** Relative route on the node's own host — set iff kind === "http-dispatch". */
  route?: string;
  /** Graph id — set iff kind === "graph". */
  graph?: string;
  /** Opaque payload forwarded verbatim. */
  payload: Record<string, JsonValue>;
}

/** Logger interface matching pino shape. */
interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Prior persisted state of a node-schedule DB row, returned by the upsert callback
 * so the PURE service can detect cron drift against the STORED cron (the SSOT —
 * Temporal can't return the original cron). Null fields ⇒ row is newly created.
 */
export interface NodeScheduleRowState {
  /** DB schedule UUID. */
  dbScheduleId: string;
  /** The cron that was stored BEFORE this upsert (null on first insert). */
  priorCron: string | null;
  /** The timezone that was stored BEFORE this upsert (null on first insert). */
  priorTimezone: string | null;
  /** The input that was stored BEFORE this upsert (null on first insert). */
  priorInput: JsonValue | null;
  /** Whether the row existed before this upsert. */
  existed: boolean;
}

/** Params for upserting a node-schedule DB row. */
export interface UpsertNodeScheduleRowParams {
  /** Temporal schedule id (`node-task:{nodeId}:{id}`). */
  temporalScheduleId: string;
  /** Owner user id (the node's tenant principal — system/operator-minted). */
  ownerUserId: string;
  /** Execution grant id scoped to this node. */
  executionGrantId: string;
  /** Graph id (real graph id for graph kind; `task:{route}` envelope id for http-dispatch). */
  graphId: string;
  /** Workflow input payload (NodeTaskInputEnvelope for http-dispatch, graph input for graph). */
  input: JsonValue;
  cron: string;
  timezone: string;
}

/** Injectable dependencies for node-schedule sync. */
export interface NodeScheduleSyncDeps {
  /**
   * Authoritative node id for this sync (the operator's resolved node identity —
   * e.g. from the nodes registry / repo-spec). Every desired entry's nodeId MUST
   * equal this; foreign-node entries are rejected (M8 defense-in-depth).
   */
  nodeId: string;
  /** Owner user id of the node's tenant principal (operator-minted). */
  ownerUserId: string;
  /**
   * Idempotent: ensure the per-node execution grant exists for `scope`, return grantId.
   * scope = `task:dispatch:{route}` (http-dispatch) or `graph:execute:{graphId}` (graph).
   */
  ensureNodeGrant(scope: string): Promise<string>;
  /** Upsert the node-schedule DB row; return its prior state (for cron-drift detection). */
  upsertNodeScheduleRow(
    params: UpsertNodeScheduleRowParams
  ): Promise<NodeScheduleRowState>;
  /** Temporal schedule lifecycle control. */
  scheduleControl: ScheduleControlPort;
  /** All Temporal schedule ids with this node's `node-task:{nodeId}:` prefix. */
  listNodeScheduleIds(): Promise<string[]>;
  /** Disable a node schedule's DB row (enabled=false) by its Temporal schedule id. */
  disableScheduleRow(temporalScheduleId: string): Promise<void>;
  /** Structured logger. */
  log: SyncLogger;
}

/** Result of a node-schedule sync operation. */
export interface NodeScheduleSyncResult {
  created: string[];
  updated: string[];
  resumed: string[];
  skipped: string[];
  paused: string[];
}

/** Error thrown when a desired schedule's nodeId differs from the authoritative nodeId (M8). */
export class ForeignNodeScheduleError extends Error {
  constructor(
    public readonly scheduleId: string,
    public readonly declaredNodeId: string,
    public readonly authoritativeNodeId: string
  ) {
    super(
      `Schedule "${scheduleId}" declares nodeId "${declaredNodeId}" but the authoritative node is "${authoritativeNodeId}" — cross-tenant schedule rejected`
    );
    this.name = "ForeignNodeScheduleError";
  }
}

export function isForeignNodeScheduleError(
  error: unknown
): error is ForeignNodeScheduleError {
  return error instanceof Error && error.name === "ForeignNodeScheduleError";
}

/**
 * Derives the Temporal schedule id for a node schedule.
 * Format: `node-task:{nodeId}:{id}` (== the workflowId — WORKFLOW_ID_STABILITY).
 */
export function nodeScheduleId(nodeId: string, id: string): string {
  return `node-task:${nodeId}:${id}`;
}

/**
 * Prefix for listing a node's schedules (prune scope).
 * Format: `node-task:{nodeId}:`
 */
export function nodeScheduleIdPrefix(nodeId: string): string {
  return `node-task:${nodeId}:`;
}

/**
 * Detects whether the desired schedule differs from what was last persisted.
 *
 * REAL_CRON_DRIFT (the fix): cron is compared against the STORED cron (`prior.priorCron`),
 * which is the SSOT — Temporal compiles crons to calendars so describeSchedule().cron is
 * always null. The governance equivalent (`scheduleConfigChanged`) skips cron entirely;
 * that is a latent bug for node-authored schedules where cron is the primary thing a node
 * changes. Here we treat a cron change as drift.
 */
function nodeScheduleDrifted(
  prior: NodeScheduleRowState,
  desc: ScheduleDescription,
  desiredCron: string,
  desiredTimezone: string,
  desiredInput: JsonValue,
  dbScheduleId: string
): boolean {
  // First-ever persistence (no prior row) is handled by create; this is the
  // conflict path, so the row exists. Compare against stored values.
  const cronChanged =
    prior.priorCron !== null && prior.priorCron !== desiredCron;
  const timezoneChanged =
    (prior.priorTimezone !== null && prior.priorTimezone !== desiredTimezone) ||
    (desc.timezone !== null && desc.timezone !== desiredTimezone);
  const inputChanged =
    (prior.priorInput !== null &&
      !isDeepStrictEqual(prior.priorInput, desiredInput)) ||
    !isDeepStrictEqual(desc.input, desiredInput);
  const linkDrift = desc.dbScheduleId !== dbScheduleId;
  return cronChanged || timezoneChanged || inputChanged || linkDrift;
}

/**
 * Builds the desired workflow params for a single node schedule.
 *
 * http-dispatch → NodeTaskWorkflow with a NodeTaskInputEnvelope tunneled inside `input`;
 *   graphId is set to the envelope id `task:{route}` to satisfy the NOT NULL constraint
 *   (zero-migration MVP — promoting `route` to a typed column is a documented follow-up).
 * graph → GraphRunWorkflow (workflowType omitted = adapter default) with the node's payload.
 */
function buildDesired(
  entry: NodeScheduleEntry,
  scheduleId: string,
  grantId: string,
  ownerUserId: string,
  dbScheduleId: string
): { params: CreateScheduleParams; input: JsonValue; graphId: string } {
  let input: JsonValue;
  let graphId: string;
  let workflowType: string | undefined;

  if (entry.kind === "http-dispatch") {
    const route = entry.route as string; // schema guarantees presence for http-dispatch
    const envelope: NodeTaskInputEnvelope = {
      kind: "node-task",
      nodeId: entry.nodeId,
      scheduleId: entry.id,
      route,
      payload: entry.payload,
    };
    input = envelope as unknown as JsonValue;
    graphId = `task:${route}`;
    workflowType = NODE_TASK_WORKFLOW_TYPE;
  } else {
    const graph = entry.graph as string; // schema guarantees presence for graph
    input = entry.payload;
    graphId = graph;
    workflowType = undefined; // adapter default → GraphRunWorkflow
  }

  const params: CreateScheduleParams = {
    scheduleId,
    nodeId: entry.nodeId,
    dbScheduleId,
    ownerUserId,
    cron: entry.cron,
    timezone: entry.timezone,
    graphId,
    executionGrantId: grantId,
    input,
    // PLATFORM_OVERLAP_AND_CATCHUP — operator-fixed, never node-tunable.
    overlapPolicy: "skip",
    catchupWindowMs: 0,
    workflowType,
  };

  return { params, input, graphId };
}

/**
 * The per-node grant scope for a schedule.
 * http-dispatch → `task:dispatch:{route}`; graph → `graph:execute:{graphId}`.
 */
function grantScopeFor(entry: NodeScheduleEntry): string {
  return entry.kind === "http-dispatch"
    ? `task:dispatch:${entry.route}`
    : `graph:execute:${entry.graph}`;
}

/**
 * Syncs a node's declarative schedules into Temporal under its tenant identity.
 *
 * For each desired schedule:
 *   - missing in Temporal → create
 *   - exists with drift (incl. CRON) → update in-place (+ resume if paused)
 *   - exists, paused, no drift → resume
 *   - exists, running, no drift → skip
 * For node schedules in Temporal but not in the spec → pause (reversible).
 *
 * @throws ForeignNodeScheduleError if any entry declares a foreign nodeId (M8).
 */
export async function syncNodeSchedules(
  entries: readonly NodeScheduleEntry[],
  deps: NodeScheduleSyncDeps
): Promise<NodeScheduleSyncResult> {
  const { scheduleControl, log } = deps;

  const result: NodeScheduleSyncResult = {
    created: [],
    updated: [],
    resumed: [],
    skipped: [],
    paused: [],
  };

  const configScheduleIds = new Set<string>();

  for (const entry of entries) {
    // M8 — reject any entry implying a foreign node (defense-in-depth; repo-spec
    // already pins nodeId, but the sync service is the trust boundary at dispatch).
    if (entry.nodeId !== deps.nodeId) {
      throw new ForeignNodeScheduleError(entry.id, entry.nodeId, deps.nodeId);
    }

    const scheduleId = nodeScheduleId(entry.nodeId, entry.id);
    configScheduleIds.add(scheduleId);

    const scope = grantScopeFor(entry);
    const grantId = await deps.ensureNodeGrant(scope);

    // Build desired with a provisional dbScheduleId; real id comes from upsert.
    // We upsert first (DB is the SSOT for stored cron), then construct params.
    const provisional = buildDesired(
      entry,
      scheduleId,
      grantId,
      deps.ownerUserId,
      "" // placeholder — replaced below
    );

    const prior = await deps.upsertNodeScheduleRow({
      temporalScheduleId: scheduleId,
      ownerUserId: deps.ownerUserId,
      executionGrantId: grantId,
      graphId: provisional.graphId,
      input: provisional.input,
      cron: entry.cron,
      timezone: entry.timezone,
    });

    const { params: desiredParams } = buildDesired(
      entry,
      scheduleId,
      grantId,
      deps.ownerUserId,
      prior.dbScheduleId
    );

    try {
      await scheduleControl.createSchedule(desiredParams);
      result.created.push(scheduleId);
      log.info(
        {
          scheduleId,
          nodeId: entry.nodeId,
          cron: entry.cron,
          kind: entry.kind,
        },
        "Created node schedule"
      );
    } catch (error) {
      if (isScheduleControlConflictError(error)) {
        const desc = await scheduleControl.describeSchedule(scheduleId);
        if (!desc) {
          // Race: schedule vanished between create and describe.
          result.skipped.push(scheduleId);
          continue;
        }

        const drifted = nodeScheduleDrifted(
          prior,
          desc,
          entry.cron,
          entry.timezone,
          provisional.input,
          prior.dbScheduleId
        );

        if (drifted) {
          await scheduleControl.updateSchedule(scheduleId, desiredParams);
          if (desc.isPaused) {
            await scheduleControl.resumeSchedule(scheduleId);
          }
          result.updated.push(scheduleId);
          log.info(
            {
              scheduleId,
              nodeId: entry.nodeId,
              cronChanged: prior.priorCron !== entry.cron,
            },
            "Updated node schedule (drift detected)"
          );
        } else if (desc.isPaused) {
          await scheduleControl.resumeSchedule(scheduleId);
          result.resumed.push(scheduleId);
          log.info(
            { scheduleId, nodeId: entry.nodeId },
            "Resumed node schedule"
          );
        } else {
          result.skipped.push(scheduleId);
          log.info(
            { scheduleId, nodeId: entry.nodeId },
            "Node schedule up to date, skipping"
          );
        }
      } else {
        throw error;
      }
    }
  }

  // Prune: pause node schedules not in current spec (reversible).
  const existingIds = await deps.listNodeScheduleIds();
  for (const existingId of existingIds) {
    if (!configScheduleIds.has(existingId)) {
      try {
        await scheduleControl.pauseSchedule(existingId);
        await deps.disableScheduleRow(existingId);
        result.paused.push(existingId);
        log.warn(
          { scheduleId: existingId, nodeId: deps.nodeId },
          "Paused node schedule (removed from repo-spec)"
        );
      } catch (error) {
        if (isScheduleControlNotFoundError(error)) {
          log.warn(
            { scheduleId: existingId, nodeId: deps.nodeId },
            "Node schedule not found in Temporal (deleted externally)"
          );
        } else {
          throw error;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Teardown (M7) — node decommission
// ---------------------------------------------------------------------------

/** Result of a node teardown operation. */
export interface NodeScheduleTeardownResult {
  pausedSchedules: string[];
  revokedGrants: string[];
}

/** Injectable dependencies for node teardown. */
export interface NodeScheduleTeardownDeps {
  /** Authoritative node id being decommissioned. */
  nodeId: string;
  /** Temporal schedule lifecycle control. */
  scheduleControl: ScheduleControlPort;
  /** All Temporal schedule ids with this node's prefix. */
  listNodeScheduleIds(): Promise<string[]>;
  /** Disable a node schedule's DB row by its Temporal schedule id. */
  disableScheduleRow(temporalScheduleId: string): Promise<void>;
  /**
   * Revoke (revokedAt) all execution grants scoped to this node. Returns the
   * revoked grant ids. SEAM (M7): coordinate with T1's grant model — once T1's
   * grant↔node binding lands, this is implemented against it.
   *
   * TODO(task.5029 seam): wire to T1's per-node grant model when merged. If T1 is
   * not merged, the caller passes a stub that no-ops + logs (leaving a typed seam).
   */
  revokeNodeGrants(): Promise<string[]>;
  /** Structured logger. */
  log: SyncLogger;
}

/**
 * Decommission a node's recurring work (M7 — TEARDOWN_REVOKES).
 *
 * One saga, idempotent + ordered: (a) pause + disable every node schedule, then
 * (b) revoke every grant scoped to the node. Ordering matters — pause first so no
 * new dispatch fires while grants are being revoked; grant revocation is the
 * fail-closed backstop (validation rejects revoked grants on any in-flight run).
 *
 * Idempotency: pause is a no-op if already paused; grant revoke is idempotent in
 * T1's model (revokedAt is set-once). Safe to re-run.
 */
export async function teardownNodeSchedules(
  deps: NodeScheduleTeardownDeps
): Promise<NodeScheduleTeardownResult> {
  const { scheduleControl, log } = deps;
  const result: NodeScheduleTeardownResult = {
    pausedSchedules: [],
    revokedGrants: [],
  };

  // (a) Pause + disable every schedule for this node.
  const ids = await deps.listNodeScheduleIds();
  for (const id of ids) {
    try {
      await scheduleControl.pauseSchedule(id);
      await deps.disableScheduleRow(id);
      result.pausedSchedules.push(id);
      log.warn(
        { scheduleId: id, nodeId: deps.nodeId },
        "Paused node schedule (decommission)"
      );
    } catch (error) {
      if (isScheduleControlNotFoundError(error)) {
        log.warn(
          { scheduleId: id, nodeId: deps.nodeId },
          "Node schedule not found in Temporal during teardown"
        );
      } else {
        throw error;
      }
    }
  }

  // (b) Revoke all grants scoped to this node (fail-closed backstop).
  const revoked = await deps.revokeNodeGrants();
  result.revokedGrants.push(...revoked);
  log.warn(
    { nodeId: deps.nodeId, revokedGrants: revoked.length },
    "Revoked node grants (decommission)"
  );

  return result;
}
