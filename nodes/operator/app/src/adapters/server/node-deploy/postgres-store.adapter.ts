// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/postgres-store.adapter`
 * Purpose: Operator-Postgres implementation of the sequencer's `StorePort` over
 *   `node_workload_desired` / `node_workload_releases` / `node_workload_attempts` (task.5400).
 * Scope: Reads and writes those three tables. No deploy policy.
 * Invariants:
 *   - RELEASE_IS_IMMUTABLE: `recordRelease` only INSERTs a release; nothing updates one.
 *   - RELEASE_AND_DESIRED_ARE_ONE_TRANSACTION: a release is never visible without desired pointing at
 *     it, and desired never points at a release that does not exist.
 *   - ORDINAL_IS_STORE_ALLOCATED: the attempt ordinal is `max+1` inside the insert transaction, with a
 *     bounded retry on the `(release_id, attempt)` / `cogni_key` unique violation, so two writers can
 *     never mint one key twice.
 *   - SPEC_IS_REVALIDATED_ON_READ: a stored release spec is re-parsed with the repo-spec schema.
 * Side-effects: IO (Postgres)
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { nodeWorkloadSpecSchema } from "@cogni/repo-spec";
import { and, desc, eq, sql } from "drizzle-orm";

import type {
  AttemptPatch,
  AttemptRow,
  DesiredRow,
  RecordReleaseInput,
  ReleaseRow,
  StorePort,
  WorkloadKey,
} from "@/ports";
import {
  nodeWorkloadAttempts,
  nodeWorkloadDesired,
  nodeWorkloadReleases,
} from "@/shared/db/node-workloads";

type AttemptDb = typeof nodeWorkloadAttempts.$inferSelect;
type ReleaseDb = typeof nodeWorkloadReleases.$inferSelect;
type DesiredDb = typeof nodeWorkloadDesired.$inferSelect;

function toAttempt(r: AttemptDb): AttemptRow {
  return {
    id: r.id,
    releaseId: r.releaseId,
    attempt: r.attempt,
    cogniKey: r.cogniKey,
    externalName: r.externalName ?? undefined,
    provider: r.provider ?? undefined,
    endpoints: r.endpoints,
    phase: r.phase as AttemptRow["phase"],
    error: r.error ?? undefined,
    unhealthySince: r.unhealthySince ?? undefined,
    createdAt: r.createdAt,
    leasedAt: r.leasedAt ?? undefined,
    updatedAt: r.updatedAt,
  };
}

function toRelease(r: ReleaseDb): ReleaseRow {
  return {
    id: r.id,
    nodeId: r.nodeId,
    env: r.env,
    workload: r.workload,
    sourceSha: r.sourceSha,
    spec: nodeWorkloadSpecSchema.parse(r.spec),
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

function toDesired(r: DesiredDb): DesiredRow {
  return {
    nodeId: r.nodeId,
    env: r.env,
    workload: r.workload,
    state: r.state === "stopped" ? "stopped" : "running",
    releaseId: r.releaseId,
    updatedAt: r.updatedAt,
    gameDayRequestedAt: r.gameDayRequestedAt ?? undefined,
  };
}

function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export class PostgresNodeDeployStore implements StorePort {
  constructor(private readonly db: Database) {}

  async getDesired(key: WorkloadKey): Promise<DesiredRow | undefined> {
    const [row] = await this.db
      .select()
      .from(nodeWorkloadDesired)
      .where(
        and(
          eq(nodeWorkloadDesired.nodeId, key.nodeId),
          eq(nodeWorkloadDesired.env, key.env),
          eq(nodeWorkloadDesired.workload, key.workload)
        )
      )
      .limit(1);
    return row ? toDesired(row) : undefined;
  }

  async requestGameDay(key: WorkloadKey): Promise<boolean> {
    const rows = await this.db
      .update(nodeWorkloadDesired)
      .set({ gameDayRequestedAt: new Date() })
      .where(
        and(
          eq(nodeWorkloadDesired.nodeId, key.nodeId),
          eq(nodeWorkloadDesired.env, key.env),
          eq(nodeWorkloadDesired.workload, key.workload)
        )
      )
      .returning({ workload: nodeWorkloadDesired.workload });
    return rows.length > 0;
  }

  async clearGameDay(key: WorkloadKey): Promise<void> {
    await this.db
      .update(nodeWorkloadDesired)
      .set({ gameDayRequestedAt: null })
      .where(
        and(
          eq(nodeWorkloadDesired.nodeId, key.nodeId),
          eq(nodeWorkloadDesired.env, key.env),
          eq(nodeWorkloadDesired.workload, key.workload)
        )
      );
  }

  async listDesired(env: string): Promise<readonly DesiredRow[]> {
    return (
      await this.db
        .select()
        .from(nodeWorkloadDesired)
        .where(eq(nodeWorkloadDesired.env, env))
    ).map(toDesired);
  }

  async getRelease(id: string): Promise<ReleaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(nodeWorkloadReleases)
      .where(eq(nodeWorkloadReleases.id, id))
      .limit(1);
    return row ? toRelease(row) : undefined;
  }

  async recordRelease(
    input: RecordReleaseInput
  ): Promise<{ release: ReleaseRow; desired: DesiredRow }> {
    return this.db.transaction(async (tx) => {
      const [rel] = await tx
        .insert(nodeWorkloadReleases)
        .values({
          nodeId: input.nodeId,
          env: input.env,
          workload: input.workload,
          sourceSha: input.sourceSha,
          spec: input.spec,
          createdBy: input.createdBy,
        })
        .returning();
      if (!rel) throw new Error("release insert returned no row");
      const [des] = await tx
        .insert(nodeWorkloadDesired)
        .values({
          nodeId: input.nodeId,
          env: input.env,
          workload: input.workload,
          state: "running",
          releaseId: rel.id,
        })
        .onConflictDoUpdate({
          target: [
            nodeWorkloadDesired.nodeId,
            nodeWorkloadDesired.env,
            nodeWorkloadDesired.workload,
          ],
          set: { state: "running", releaseId: rel.id, updatedAt: sql`now()` },
        })
        .returning();
      if (!des) throw new Error("desired upsert returned no row");
      return { release: toRelease(rel), desired: toDesired(des) };
    });
  }

  async attemptsFor(key: WorkloadKey): Promise<readonly AttemptRow[]> {
    const rows = await this.db
      .select({ a: nodeWorkloadAttempts })
      .from(nodeWorkloadAttempts)
      .innerJoin(
        nodeWorkloadReleases,
        eq(nodeWorkloadAttempts.releaseId, nodeWorkloadReleases.id)
      )
      .where(
        and(
          eq(nodeWorkloadReleases.nodeId, key.nodeId),
          eq(nodeWorkloadReleases.env, key.env),
          eq(nodeWorkloadReleases.workload, key.workload)
        )
      )
      .orderBy(
        desc(nodeWorkloadAttempts.createdAt),
        desc(nodeWorkloadAttempts.attempt)
      )
      .limit(200);
    return rows.map((r) => toAttempt(r.a));
  }

  async insertAttempt(
    releaseId: string,
    makeKey: (attempt: number) => string
  ): Promise<AttemptRow> {
    for (let tries = 0; tries < 5; tries++) {
      try {
        return await this.db.transaction(async (tx) => {
          const [max] = await tx
            .select({
              n: sql<number>`coalesce(max(${nodeWorkloadAttempts.attempt}), 0)::int`,
            })
            .from(nodeWorkloadAttempts)
            .where(eq(nodeWorkloadAttempts.releaseId, releaseId));
          const attempt = (max?.n ?? 0) + 1;
          const [row] = await tx
            .insert(nodeWorkloadAttempts)
            .values({
              releaseId,
              attempt,
              cogniKey: makeKey(attempt),
              endpoints: [],
              phase: "planned",
            })
            .returning();
          if (!row) throw new Error("attempt insert returned no row");
          return toAttempt(row);
        });
      } catch (error) {
        if (!isUniqueViolation(error) || tries === 4) throw error;
      }
    }
    throw new Error("unreachable");
  }

  async updateAttempt(id: string, patch: AttemptPatch): Promise<AttemptRow> {
    const set: Partial<typeof nodeWorkloadAttempts.$inferInsert> = {};
    if (patch.phase !== undefined) {
      set.phase = patch.phase;
      set.updatedAt = new Date();
    }
    if (patch.externalName !== undefined) set.externalName = patch.externalName;
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.endpoints !== undefined) set.endpoints = [...patch.endpoints];
    if (patch.error !== undefined) set.error = patch.error;
    if (patch.unhealthySince !== undefined)
      set.unhealthySince = patch.unhealthySince;
    if (patch.leasedAt !== undefined) set.leasedAt = patch.leasedAt;
    const [row] = await this.db
      .update(nodeWorkloadAttempts)
      .set(set)
      .where(eq(nodeWorkloadAttempts.id, id))
      .returning();
    if (!row) throw new Error(`attempt ${id} not found`);
    return toAttempt(row);
  }
}
