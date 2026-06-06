// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/schedule`
 * Purpose: Factory for ScheduleCapability — bridges ai-tools interface to ScheduleUserPort with RLS-scoped user identity.
 * Scope: Creates ScheduleCapability that reads actorUserId from ExecutionScope (ALS) at invocation time. Does not implement transport.
 * Invariants:
 *   - RLS_ENFORCED: All schedule operations use the real user's identity, never system principal
 *   - CRUD_IS_TEMPORAL_AUTHORITY: All mutations go through ScheduleUserPort → Temporal
 * Side-effects: none (factory only)
 * Links: docs/spec/scheduler.md
 * @internal
 */

import type {
  ScheduleCapability,
  ScheduleCreateParams,
  ScheduleInfo,
  ScheduleUpdateParams,
} from "@cogni/ai-tools";
import type { UserId } from "@cogni/ids";
import { toUserId } from "@cogni/ids";
import type { ScheduleUserPort } from "@cogni/scheduler-core";

import { getExecutionScope } from "@/adapters/server";
import { getNodeId } from "@/shared/config";

/**
 * Dependencies for creating the schedule capability.
 */
export interface ScheduleCapabilityDeps {
  readonly scheduleManager: ScheduleUserPort;
  readonly getOrCreateBillingAccountId: (userId: UserId) => Promise<string>;
}

/**
 * Resolve the current actor's userId from ExecutionScope (ALS).
 * Throws if no execution scope or no actorUserId — tools must run within a graph execution.
 */
function resolveUserId(): UserId {
  const scope = getExecutionScope();
  if (!scope.actorUserId) {
    throw new Error(
      "ScheduleCapability: actorUserId not set in ExecutionScope. " +
        "Schedule tools must run within an authenticated graph execution."
    );
  }
  return toUserId(scope.actorUserId);
}

function toScheduleInfo(spec: {
  id: string;
  graphId: string;
  input: unknown;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ScheduleInfo {
  return {
    id: spec.id,
    graphId: spec.graphId,
    input: spec.input as Record<string, unknown>,
    cron: spec.cron,
    timezone: spec.timezone,
    enabled: spec.enabled,
    nextRunAt: spec.nextRunAt?.toISOString() ?? null,
    lastRunAt: spec.lastRunAt?.toISOString() ?? null,
    createdAt: spec.createdAt.toISOString(),
    updatedAt: spec.updatedAt.toISOString(),
  };
}

/**
 * Create a ScheduleCapability that resolves user identity from ALS at call time.
 *
 * This ensures RLS is always enforced — the capability operates as the real user,
 * not a system principal.
 */
export function createScheduleCapability(
  deps: ScheduleCapabilityDeps
): ScheduleCapability {
  const { scheduleManager, getOrCreateBillingAccountId } = deps;

  return {
    async list(): Promise<readonly ScheduleInfo[]> {
      const userId = resolveUserId();
      const schedules = await scheduleManager.listSchedules(userId);
      return schedules.map(toScheduleInfo);
    },

    async create(input: ScheduleCreateParams): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      const billingAccountId = await getOrCreateBillingAccountId(userId);
      const spec = await scheduleManager.createSchedule(
        userId,
        billingAccountId,
        {
          nodeId: getNodeId(),
          graphId: input.graphId,
          input: input.input,
          cron: input.cron,
          timezone: input.timezone,
        }
      );
      return toScheduleInfo(spec);
    },

    async update(
      scheduleId: string,
      patch: ScheduleUpdateParams
    ): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      const spec = await scheduleManager.updateSchedule(
        userId,
        scheduleId,
        patch
      );
      return toScheduleInfo(spec);
    },

    async remove(scheduleId: string): Promise<void> {
      const userId = resolveUserId();
      await scheduleManager.deleteSchedule(userId, scheduleId);
    },

    async setEnabled(
      scheduleId: string,
      enabled: boolean
    ): Promise<ScheduleInfo> {
      const userId = resolveUserId();
      const spec = await scheduleManager.updateSchedule(userId, scheduleId, {
        enabled,
      });
      return toScheduleInfo(spec);
    },
  };
}
