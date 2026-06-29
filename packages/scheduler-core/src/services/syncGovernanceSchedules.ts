// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/services/syncGovernanceSchedules`
 * Purpose: Sync governance schedules from config to Temporal. Pure orchestration — depends only on ports and types.
 * Scope: Creates/updates/resumes Temporal schedules for each charter in governance config; pauses schedules removed from config. Routes LEDGER_INGEST charters to CollectEpochWorkflow with versioned LedgerIngestRunV1 envelope. Does not manage tenant-facing schedule CRUD or workflow execution.
 * Invariants:
 *   - OVERLAP_SKIP_DEFAULT: All governance schedules use overlap=SKIP (enforced by ScheduleControlPort)
 *   - CATCHUP_WINDOW_ZERO: No backfill (enforced by ScheduleControlPort)
 *   - PRUNE_IS_PAUSE: Removed schedules are paused, never deleted (reversible)
 *   - SYSTEM_OPS_ONLY: This function runs at deploy time, never exposed as an API endpoint
 *   - PURE_ORCHESTRATION: No adapters, no Temporal client — only ports/types/callbacks
 *   - SYSTEM_TENANT_IS_TENANT: Governance schedules are first-class DB rows owned by system principal
 *   - UPDATE_ON_DRIFT: Existing schedules are updated in-place when config changes (model, cron, timezone, input)
 * Side-effects: IO (Temporal RPC via ScheduleControlPort, grant creation via ensureGovernanceGrant)
 * Links: docs/spec/scheduler.md, docs/spec/governance-council.md, .cogni/repo-spec.yaml
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

/** Graph ID for OpenClaw sandbox execution */
const GOVERNANCE_GRAPH_ID = "sandbox:openclaw";

/** Default model for governance agent runs */
// TODO(task.0068): Use default_flash from LiteLLM config metadata instead of hardcoded model
const GOVERNANCE_MODEL = "kimi-k2.5";

/** Workflow type for ledger ingestion */
const COLLECT_EPOCH_WORKFLOW_TYPE = "CollectEpochWorkflow";

/** Task queue for ledger activities */
const LEDGER_TASK_QUEUE = "ledger-tasks";

/** Minimal governance schedule shape (no @/ imports — pure type) */
export interface GovernanceScheduleEntry {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
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
 * Derives the Temporal schedule ID from a charter name.
 * Format: `governance:{charter_lowercase}`
 */
export function governanceScheduleId(charter: string): string {
  return `governance:${charter.toLowerCase()}`;
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
  input: JsonValue
): boolean {
  return (
    (desc.timezone !== null && desc.timezone !== timezone) ||
    !isDeepStrictEqual(desc.input, input)
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

  // 1. Ensure governance grant exists for cogni_system
  const grantId = await deps.ensureGovernanceGrant();
  log.info({ grantId }, "Governance grant ready");

  // 2. Create, update, or resume schedules from config
  const result: GovernanceScheduleSyncResult = {
    created: [],
    updated: [],
    resumed: [],
    skipped: [],
    paused: [],
  };

  const configScheduleIds = new Set<string>();

  for (const schedule of config.schedules) {
    const scheduleId = governanceScheduleId(schedule.charter);
    configScheduleIds.add(scheduleId);

    // Determine if this is a LEDGER_INGEST schedule (different workflow + queue)
    const isLedgerIngest = schedule.charter.toUpperCase() === "LEDGER_INGEST";

    let desiredInput: JsonValue;
    let workflowType: string | undefined;
    let taskQueueOverride: string | undefined;
    let graphId: string;

    if (isLedgerIngest && config.ledger) {
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
      taskQueueOverride = LEDGER_TASK_QUEUE;
      // Ledger workflows don't use graph/grant auth, but CreateScheduleParams requires graphId
      graphId = "ledger:ingest";
    } else {
      desiredInput = {
        message: schedule.entrypoint,
        model: GOVERNANCE_MODEL,
      };
      graphId = GOVERNANCE_GRAPH_ID;
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
      workflowType,
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
          desiredInput
        );
        const linkDrift = desc.dbScheduleId !== dbScheduleId;

        if (configChanged || linkDrift) {
          await scheduleControl.updateSchedule(scheduleId, desiredParams);
          if (desc.isPaused) {
            await scheduleControl.resumeSchedule(scheduleId);
          }
          result.updated.push(scheduleId);
          log.info(
            { scheduleId, configChanged, linkDrift },
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
