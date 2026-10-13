// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema.scheduling`
 * Purpose: Scheduling and graph execution tables schema.
 * Scope: Defines execution_grants, schedules, graph_runs tables. Does not contain queries or logic.
 * Invariants:
 * - execution_grants: Durable authorization for scheduled runs (not user sessions)
 * - schedules: Cron-based graph execution definitions
 * - graph_runs: Single canonical run ledger for all execution types (SINGLE_RUN_LEDGER)
 * - Per SCHEDULER_SPEC.md: job_key = scheduleId:scheduledFor for Graphile Worker
 * - UNIQUE(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL on graph_runs prevents duplicate run records per slot
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/scheduler.md, docs/spec/unified-graph-launch.md, types/scheduling.ts
 * @public
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingAccounts, users } from "./refs";

/**
 * Graph run status values (source of truth for DB enum).
 * Per SINGLE_RUN_LEDGER: single status enum for all run types.
 * - pending: Run enqueued, not yet started
 * - running: Execution in progress
 * - success: Completed successfully
 * - error: Failed with error
 * - timeout: Transport outcome remained unknown after the recovery budget
 * - skipped: Skipped (disabled schedule or revoked grant)
 * - cancelled: Cancelled by user or system
 */
export const GRAPH_RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "timeout",
  "skipped",
  "cancelled",
] as const;

export type GraphRunStatus = (typeof GRAPH_RUN_STATUSES)[number];

/**
 * Graph run kind — how the run was triggered.
 * Per SINGLE_RUN_LEDGER: all triggers produce the same run record shape.
 */
export const GRAPH_RUN_KINDS = [
  "user_immediate",
  "system_scheduled",
  "system_webhook",
] as const;

export type GraphRunKind = (typeof GRAPH_RUN_KINDS)[number];

/**
 * Execution grants - durable authorization for scheduled graph execution.
 * Per GRANT_NOT_SESSION: Workers authenticate via grants, never user sessions.
 * Per GRANT_SCOPES_CONSTRAIN_GRAPHS: Scopes specify which graphIds can execute.
 *
 * Scope format: "graph:execute:{graphId}" or "graph:execute:*" for wildcard.
 * Example: ["graph:execute:langgraph:poet", "graph:execute:langgraph:research"]
 */
export const executionGrants = pgTable(
  "execution_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    /** Scopes array: ["graph:execute:langgraph:poet", "graph:execute:*"] */
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("execution_grants_user_idx").on(table.userId),
    billingAccountIdx: index("execution_grants_billing_account_idx").on(
      table.billingAccountId
    ),
  })
).enableRLS();

/**
 * Schedules - cron-based graph execution definitions.
 * Per SCHEDULER_SPEC.md: next_run_at is updated after each execution.
 * Graphile Worker job_key = scheduleId:scheduledFor prevents duplicate jobs.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    executionGrantId: uuid("execution_grant_id")
      .notNull()
      .references(() => executionGrants.id, { onDelete: "cascade" }),
    /** Graph ID in format provider:name (e.g., "langgraph:poet") */
    graphId: text("graph_id").notNull(),
    /** Graph input payload (messages, model, etc.) */
    input: jsonb("input").$type<unknown>().notNull(),
    /** 5-field cron expression */
    cron: text("cron").notNull(),
    /** IANA timezone (e.g., "UTC", "America/New_York") */
    timezone: text("timezone").notNull(),
    /**
     * Temporal schedule ID override. When NULL, Temporal ID = row.id (user schedules).
     * When set, maps this DB row to a semantic Temporal schedule (e.g., "governance:community").
     */
    temporalScheduleId: text("temporal_schedule_id"),
    /** Pause/resume toggle */
    enabled: boolean("enabled").notNull().default(true),
    /** Next scheduled execution time (null if disabled or no future runs) */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Last execution start time */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerIdx: index("schedules_owner_idx").on(table.ownerUserId),
    /** For reconciler: find enabled schedules with stale next_run_at */
    nextRunIdx: index("schedules_next_run_idx").on(table.nextRunAt),
    grantIdx: index("schedules_grant_idx").on(table.executionGrantId),
    /** Prevents duplicate governance rows under retries/concurrency */
    temporalIdUnique: uniqueIndex("schedules_temporal_id_unique")
      .on(table.ownerUserId, table.temporalScheduleId)
      .where(sql`temporal_schedule_id IS NOT NULL`),
  })
).enableRLS();

/**
 * Graph runs — single canonical run ledger for all execution types.
 * Per SINGLE_RUN_LEDGER: promoted from schedule_runs. One table for API, scheduled, and webhook runs.
 * Per unified-graph-launch.md: trigger provenance stored per run.
 * UNIQUE(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL prevents duplicate scheduled run records.
 */
export const graphRuns = pgTable(
  "graph_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Schedule FK — nullable, only set for scheduled runs */
    scheduleId: uuid("schedule_id").references(() => schedules.id, {
      onDelete: "cascade",
    }),
    /** GraphExecutorPort runId for correlation with charge_receipts */
    runId: text("run_id").notNull(),
    /** Graph ID in format provider:name (e.g., "langgraph:poet") */
    graphId: text("graph_id"),
    /** How the run was triggered */
    runKind: text("run_kind", { enum: GRAPH_RUN_KINDS }),
    /** Trigger source identifier (api, temporal_schedule, webhook:{type}) */
    triggerSource: text("trigger_source"),
    /** Upstream delivery/schedule ID for provenance */
    triggerRef: text("trigger_ref"),
    /** User ID (UUID) of the principal who requested/owns this run */
    requestedBy: text("requested_by"),
    /** Intended execution time (the cron slot) — only for scheduled runs */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** Actual start time */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Completion time */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Run status: pending, running, success, error, timeout, skipped, cancelled */
    status: text("status", { enum: GRAPH_RUN_STATUSES })
      .notNull()
      .default("pending"),
    /** Retry attempt count */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Langfuse trace ID for observability correlation */
    langfuseTraceId: text("langfuse_trace_id"),
    /** Error code if status is 'error' */
    errorCode: text("error_code"),
    /** Error message if status is 'error' */
    errorMessage: text("error_message"),
    /** Thread state key for conversation correlation — nullable (headless runs have none) */
    stateKey: text("state_key"),
  },
  (table) => ({
    scheduleIdx: index("graph_runs_schedule_idx").on(table.scheduleId),
    scheduledForIdx: index("graph_runs_scheduled_for_idx").on(
      table.scheduledFor
    ),
    /** Prevent duplicate run records for the same schedule slot (scheduled runs only) */
    scheduleSlotUnique: uniqueIndex("graph_runs_schedule_slot_unique")
      .on(table.scheduleId, table.scheduledFor)
      .where(sql`schedule_id IS NOT NULL`),
    /** For querying runs by runId (correlation with charge_receipts) */
    runIdIdx: index("graph_runs_run_id_idx").on(table.runId),
    /** For querying runs by kind */
    runKindIdx: index("graph_runs_run_kind_idx").on(table.runKind),
    /** For thread↔run correlation (join graph_runs to ai_threads by stateKey) */
    stateKeyIdx: index("graph_runs_state_key_idx").on(table.stateKey),
    /** For user-scoped run listing: WHERE requested_by = ? ORDER BY started_at DESC */
    requestedByStartedAtIdx: index("graph_runs_requested_by_started_at_idx").on(
      table.requestedBy,
      table.startedAt
    ),
  })
).enableRLS();

/**
 * Execution requests - idempotency layer for graph execution via internal API.
 * Per EXECUTION_IDEMPOTENCY_PERSISTED: Persists idempotency key → {ok, runId, traceId, errorCode}.
 * This is the correctness layer for slot deduplication.
 *
 * Key format: `scheduleId:TemporalScheduledStartTime`
 * Lifecycle: pending (ok=null) → finalized (ok=true/false)
 * - On request start: create row with ok=null (pending)
 * - On completion: update ok + errorCode (finalized)
 * - On retry: if ok=null, execution in progress; if ok!=null, return cached outcome
 * If idempotency_key exists but request_hash differs, reject with 422 (payload mismatch).
 */
export const executionRequests = pgTable("execution_requests", {
  /** Primary key: idempotency key (e.g., `scheduleId:TemporalScheduledStartTime`) */
  idempotencyKey: text("idempotency_key").primaryKey(),
  /** SHA256 hash of graph identity plus exact request bytes */
  requestHash: text("request_hash").notNull(),
  /** GraphExecutorPort runId for correlation */
  runId: text("run_id").notNull(),
  /** Langfuse trace ID (optional, set when Langfuse is configured) */
  traceId: text("trace_id"),
  /**
   * Execution outcome: true = success, false = error, null = pending.
   * Pending state indicates execution in progress (not yet finalized).
   */
  ok: boolean("ok"),
  /** AiExecutionErrorCode if ok=false, null if ok=true or pending */
  errorCode: text("error_code"),
  /** When request was first received */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Last lease heartbeat or terminal update */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Graph claim lease; null after finalization or for non-leased generic jobs */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
});
