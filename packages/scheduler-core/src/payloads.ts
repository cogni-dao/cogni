// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/payloads`
 * Purpose: Zod schemas for Graphile Worker job payloads.
 * Scope: Shared contract between job producers and consumers. Does not contain task implementations.
 * Invariants:
 * - Producer validates before enqueue
 * - Consumer validates at task entry
 * - No `payload as X` casts allowed
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @public
 */

import { z } from "zod";

/**
 * Payload schema for execute_scheduled_run task.
 */
export const ExecuteScheduledRunPayloadSchema = z.object({
  scheduleId: z.string().uuid(),
  scheduledFor: z.string().datetime(), // ISO 8601 timestamp
});

export type ExecuteScheduledRunPayload = z.infer<
  typeof ExecuteScheduledRunPayloadSchema
>;

/**
 * Payload schema for reconcile_schedules task.
 * Empty object - reconciler takes no payload.
 */
export const ReconcileSchedulesPayloadSchema = z.object({});

export type ReconcileSchedulesPayload = z.infer<
  typeof ReconcileSchedulesPayloadSchema
>;

/**
 * Task identifiers for Graphile Worker.
 */
export const SCHEDULER_TASK_IDS = {
  EXECUTE_SCHEDULED_RUN: "execute_scheduled_run",
  RECONCILE_SCHEDULES: "reconcile_schedules",
} as const;

export type SchedulerTaskId =
  (typeof SCHEDULER_TASK_IDS)[keyof typeof SCHEDULER_TASK_IDS];
