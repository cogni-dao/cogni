// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/governance/execution-grant.int`
 * Purpose: Component test for ExecutionGrantUserPort.ensureGrant.
 * Scope: Verifies ensureGrant finds existing grants, creates new grants, and checks scope subsets. Does not test RLS or tenant isolation.
 * Invariants: IDEMPOTENT (same grant on repeat call), SCOPE_SUBSET (existing grant must include requested scopes)
 * Side-effects: IO
 * Links: packages/db-client/src/adapters/drizzle-grant.adapter.ts
 * @public
 */

import { DrizzleExecutionGrantUserAdapter } from "@cogni/db-client";
import { executionGrants } from "@cogni/db-schema";
import { toUserId } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

describe("ExecutionGrantUserPort.ensureGrant (Component)", () => {
  const db = getSeedDb();
  const log = pino({ level: "silent" });
  const adapter = new DrizzleExecutionGrantUserAdapter(db, log);

  let actor: TestActor;
  let testUserId: ReturnType<typeof toUserId>;

  beforeAll(async () => {
    actor = await seedTestActor(db);
    testUserId = toUserId(actor.user.id);
  });

  afterEach(async () => {
    await db
      .delete(executionGrants)
      .where(eq(executionGrants.userId, testUserId));
  });

  it("creates a new grant when none exists", async () => {
    const grant = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    expect(grant.id).toBeDefined();
    expect(grant.userId).toBe(testUserId);
    expect(grant.billingAccountId).toBe(actor.billingAccountId);
    expect(grant.scopes).toEqual(["graph:execute:test"]);
    expect(grant.revokedAt).toBeNull();
  });

  it("returns existing grant when scopes match", async () => {
    const grant1 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    const grant2 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    expect(grant2.id).toBe(grant1.id);

    const grants = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, testUserId));

    expect(grants).toHaveLength(1);
  });

  it("returns existing grant when requested scopes are a subset", async () => {
    const grant1 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test", "graph:execute:other"],
    });

    const grant2 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    expect(grant2.id).toBe(grant1.id);
  });

  it("creates new grant when requested scopes are not a subset", async () => {
    const grant1 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    const grant2 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:other"],
    });

    expect(grant2.id).not.toBe(grant1.id);

    const grants = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, testUserId));

    expect(grants).toHaveLength(2);
  });

  it("ignores revoked grants when finding existing", async () => {
    const grant1 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    await adapter.revokeGrant(testUserId, grant1.id);

    const grant2 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    expect(grant2.id).not.toBe(grant1.id);
    expect(grant2.revokedAt).toBeNull();
  });

  it("ignores expired grants when finding existing", async () => {
    const grant1 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    const pastDate = new Date(Date.now() - 1000);
    await db
      .update(executionGrants)
      .set({ expiresAt: pastDate })
      .where(eq(executionGrants.id, grant1.id));

    const grant2 = await adapter.ensureGrant({
      userId: testUserId,
      billingAccountId: actor.billingAccountId,
      scopes: ["graph:execute:test"],
    });

    expect(grant2.id).not.toBe(grant1.id);
  });
});
