// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/governance/drizzle-governance-status`
 * Purpose: Drizzle implementation of GovernanceStatusPort for system tenant governance queries.
 * Scope: Read-only queries against schedules and ai_threads tables for system tenant. Does not contain business logic or handle authentication.
 * Invariants:
 * - SYSTEM_TENANT_SCOPE: All queries filter by COGNI_SYSTEM_PRINCIPAL_USER_ID
 * - RLS_COMPATIBLE: Queries use owner_user_id filter
 * - Returns Date objects (not ISO strings)
 * Side-effects: IO (database reads)
 * Links: src/ports/governance-status.port.ts, docs/spec/governance-status-api.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import type { ActorId } from "@cogni/ids";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import cronParser from "cron-parser";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@/adapters/server/db/client";
import type { GovernanceRun, GovernanceStatusPort, UpcomingRun } from "@/ports";
import { aiThreads, schedules } from "@/shared/db/schema";

export class DrizzleGovernanceStatusAdapter implements GovernanceStatusPort {
  constructor(
    private readonly db: Database,
    private readonly actorId: ActorId
  ) {}

  async getUpcomingRuns(params: { limit: number }): Promise<UpcomingRun[]> {
    // Compute next occurrence live from cron so results are always in the future.
    // next_run_at in DB is a stale cache — not used here.
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const rows = await tx
        .select({
          cron: schedules.cron,
          timezone: schedules.timezone,
          temporalScheduleId: schedules.temporalScheduleId,
        })
        .from(schedules)
        .where(
          and(
            eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            eq(schedules.enabled, true),
            isNotNull(schedules.temporalScheduleId)
          )
        );

      const now = new Date();
      return rows
        .flatMap((row) => {
          const tid = row.temporalScheduleId;
          if (tid == null) return [];
          const rawName = tid.replace(/^governance:/, "");
          const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          const nextRunAt = cronParser
            .parseExpression(row.cron, { currentDate: now, tz: row.timezone })
            .next()
            .toDate();
          return { name, nextRunAt };
        })
        .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
        .slice(0, params.limit);
    });
  }

  async getRecentRuns(params: { limit: number }): Promise<GovernanceRun[]> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const threads = await tx
        .select({
          stateKey: aiThreads.stateKey,
          metadata: aiThreads.metadata,
          createdAt: aiThreads.createdAt,
          updatedAt: aiThreads.updatedAt,
        })
        .from(aiThreads)
        .where(
          and(
            eq(aiThreads.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            isNull(aiThreads.deletedAt)
          )
        )
        .orderBy(desc(aiThreads.updatedAt))
        .limit(params.limit);

      return threads.map((t) => ({
        id: t.stateKey,
        title: (t.metadata as { title?: string } | null)?.title ?? null,
        startedAt: t.createdAt,
        lastActivity: t.updatedAt,
      }));
    });
  }
}
