// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/postgres-store.adapter`
 * Purpose: Operator-Postgres implementation of the sequencer's `StorePort` over
 *   `node_workload_desired` / `node_workload_releases` / `node_workload_attempts` (task.5400).
 * Scope: Reads and writes those three tables. No deploy policy.
 * Invariants:
 *   - RELEASE_IS_IMMUTABLE: `recordRelease` only INSERTs a release; nothing updates one except
 *     atomic image/bundle sealing and a store-owned write-once admission refusal. Refusal only
 *     appends metadata; it cannot alter the accepted bundle, spec or primary image.
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
import { z } from "zod";

import type {
  AttemptPatch,
  AttemptRow,
  AttemptStep,
  DesiredRow,
  RecordReleaseInput,
  ReleaseRow,
  StorePort,
  WorkloadKey,
} from "@/ports";
import { MAX_ATTEMPT_STEPS, withResolvedImage } from "@/ports";
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
    steps: r.steps ?? [],
  };
}

// This key belongs to the release store, never the declared NodeWorkloadSpec.
const admissionRefusalSchema = z
  .object({
    reason: z.string().min(1).max(600),
    at: z.string().datetime(),
  })
  .strict();
const storedReleaseSchema = z
  .object({
    _admissionRefusal: admissionRefusalSchema.optional(),
  })
  .passthrough();

function toRelease(r: ReleaseDb): ReleaseRow {
  const { _admissionRefusal, ...spec } = storedReleaseSchema.parse(r.spec);
  return {
    id: r.id,
    nodeId: r.nodeId,
    env: r.env,
    workload: r.workload,
    sourceSha: r.sourceSha,
    spec: withResolvedImage(
      nodeWorkloadSpecSchema.parse(spec),
      r.resolvedImage ?? undefined
    ),
    admissionRefusal: _admissionRefusal,
    resolvedImage: r.resolvedImage ?? undefined,
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

  async pinResolvedImage(
    releaseId: string,
    image: string
  ): Promise<ReleaseRow> {
    // WRITE_ONCE: only the first writer sets it; a loser (or a retry) reads the row that won.
    await this.db
      .update(nodeWorkloadReleases)
      .set({ resolvedImage: image })
      .where(
        and(
          eq(nodeWorkloadReleases.id, releaseId),
          sql`${nodeWorkloadReleases.resolvedImage} IS NULL`,
          sql`${nodeWorkloadReleases.spec}->'_admissionRefusal' IS NULL`
        )
      );
    const release = await this.getRelease(releaseId);
    if (!release) throw new Error(`release ${releaseId} not found`);
    return release;
  }

  async refuseAdmission(
    releaseId: string,
    refusal: NonNullable<ReleaseRow["admissionRefusal"]>
  ): Promise<ReleaseRow> {
    const verdict = admissionRefusalSchema.parse(refusal);
    // One row-level atomic JSON append preserves every sealed artifact and the first refusal.
    await this.db
      .update(nodeWorkloadReleases)
      .set({
        spec: sql`jsonb_set(${nodeWorkloadReleases.spec}, '{_admissionRefusal}', ${JSON.stringify(verdict)}::jsonb)`,
      })
      .where(
        and(
          eq(nodeWorkloadReleases.id, releaseId),
          sql`${nodeWorkloadReleases.spec}->'_admissionRefusal' IS NULL`
        )
      );
    const release = await this.getRelease(releaseId);
    if (!release?.admissionRefusal)
      throw new Error("admission refusal not confirmed");
    return release;
  }

  async acceptedBundle(release: ReleaseRow): Promise<string | undefined> {
    const plan = release.spec.artifactPlan;
    if (!plan) return undefined;
    const rows = await this.db
      .select()
      .from(nodeWorkloadReleases)
      .where(
        and(
          eq(nodeWorkloadReleases.nodeId, release.nodeId),
          eq(nodeWorkloadReleases.sourceSha, release.sourceSha),
          sql`${nodeWorkloadReleases.spec}->'artifactPlan'->>'repository' = ${plan.repository}`,
          sql`${nodeWorkloadReleases.spec}->'artifactPlan'->>'bundleDigest' IS NOT NULL`,
          sql`${nodeWorkloadReleases.resolvedImage} IS NOT NULL`
        )
      )
      .limit(1);
    return rows[0]
      ? toRelease(rows[0]).spec.artifactPlan?.bundleDigest
      : undefined;
  }

  async pinResolvedBundle(
    releaseId: string,
    spec: ReleaseRow["spec"]
  ): Promise<ReleaseRow | undefined> {
    const validated = nodeWorkloadSpecSchema.parse(spec);
    if (
      !validated.artifactPlan?.bundleDigest ||
      !validated.artifactPlan.selectedImages ||
      validated.imagePending ||
      validated.companions?.some((c) => c.imagePending)
    )
      throw new Error("cannot seal incomplete bundle");
    return this.db.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(nodeWorkloadReleases)
        .where(eq(nodeWorkloadReleases.id, releaseId));
      if (!initial) throw new Error("release missing");
      const rel = toRelease(initial);
      const plan = rel.spec.artifactPlan;
      if (!plan || plan.repository !== validated.artifactPlan?.repository)
        throw new Error("bundle source mismatch");
      // Every environment for this node/repository/source shares the same short first-acceptance lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${rel.nodeId}/${plan.repository}/${rel.sourceSha}`}, 0))`
      );
      const [winner] = await tx
        .select()
        .from(nodeWorkloadReleases)
        .where(
          and(
            eq(nodeWorkloadReleases.nodeId, rel.nodeId),
            eq(nodeWorkloadReleases.sourceSha, rel.sourceSha),
            sql`${nodeWorkloadReleases.spec}->'artifactPlan'->>'repository' = ${plan.repository}`,
            sql`${nodeWorkloadReleases.spec}->'artifactPlan'->>'bundleDigest' IS NOT NULL`,
            sql`${nodeWorkloadReleases.resolvedImage} IS NOT NULL`
          )
        )
        .limit(1);
      if (
        winner &&
        toRelease(winner).spec.artifactPlan?.bundleDigest !==
          validated.artifactPlan?.bundleDigest
      )
        return undefined;
      await tx
        .update(nodeWorkloadReleases)
        .set({ spec: validated, resolvedImage: validated.image })
        .where(
          and(
            eq(nodeWorkloadReleases.id, releaseId),
            sql`${nodeWorkloadReleases.resolvedImage} IS NULL`,
            sql`${nodeWorkloadReleases.spec}->'_admissionRefusal' IS NULL`
          )
        );
      const [row] = await tx
        .select()
        .from(nodeWorkloadReleases)
        .where(eq(nodeWorkloadReleases.id, releaseId));
      if (!row) throw new Error("sealed release missing");
      return toRelease(row);
    });
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
          // Serialize allocation with terminal refusal. No attempt can be inserted after it.
          const [release] = await tx
            .select()
            .from(nodeWorkloadReleases)
            .where(eq(nodeWorkloadReleases.id, releaseId))
            .for("update");
          if (!release) throw new Error("release missing");
          if (toRelease(release).admissionRefusal)
            throw new Error("release admission refused");
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

  async appendAttemptStep(attemptId: string, step: AttemptStep): Promise<void> {
    // One atomic statement: append, then keep the NEWEST `MAX_ATTEMPT_STEPS` (a failing attempt's last
    // steps matter most). No read-modify-write window; `phase` and `updated_at` are untouched.
    const joined = sql`(coalesce(${nodeWorkloadAttempts.steps}, '[]'::jsonb) || ${JSON.stringify([step])}::jsonb)`;
    await this.db
      .update(nodeWorkloadAttempts)
      .set({
        steps: sql`(
          select coalesce(jsonb_agg(t.e order by t.o), '[]'::jsonb)
          from jsonb_array_elements(${joined}) with ordinality as t(e, o)
          where t.o > jsonb_array_length(${joined}) - ${MAX_ATTEMPT_STEPS}
        )`,
      })
      .where(eq(nodeWorkloadAttempts.id, attemptId));
  }
}
