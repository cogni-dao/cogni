// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/rls-adapter-wiring.int.test`
 * Purpose: Gate tests that FAIL until adapters internally call setTenantContext under RLS.
 * Scope: Calls real adapter methods through an RLS-enforced connection with no external withTenantScope wrapper. Does not test cross-tenant isolation (see rls-tenant-isolation.int.test.ts).
 * Invariants:
 * - Adapters must scope themselves; the caller does NOT wrap in withTenantScope
 * - All wiring gates pass (schedules, accounts, payment attempts wired)
 * Side-effects: IO (database operations via testcontainers)
 * Notes: Uses production app_user role (FORCE RLS via provision.sh) for rlsDb.
 *        getSeedDb() (app_service, BYPASSRLS) handles seed/cleanup.
 * Links: docs/spec/database-rls.md (Adapter Wiring Tracker), rls-tenant-isolation.int.test.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { type Database, DrizzleScheduleUserAdapter } from "@cogni/db-client";
import {
  billingAccounts,
  executionGrants,
  paymentAttempts,
  schedules,
  users,
  virtualKeys,
} from "@cogni/db-schema";
import { toUserId } from "@cogni/ids";
import { generateTestWallet } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import { getAppDb } from "@/adapters/server/db/client";
import { UserDrizzlePaymentAttemptRepository } from "@/adapters/server/payments/drizzle-payment-attempt.adapter";

interface TestTenant {
  userId: string;
  billingAccountId: string;
  executionGrantId: string;
  scheduleId: string;
}

describe("RLS Adapter Wiring Gate", () => {
  let superDb: Database;
  let rlsDb: Database;
  let tenantA: TestTenant;

  beforeAll(async () => {
    // superDb uses service role (BYPASSRLS) for seed/cleanup
    superDb = getSeedDb();
    // rlsDb uses app_user role (FORCE RLS) — production roles from provision.sh
    rlsDb = getAppDb();

    // Seed tenant data as superuser (bypasses RLS)
    tenantA = {
      userId: randomUUID(),
      billingAccountId: randomUUID(),
      executionGrantId: randomUUID(),
      scheduleId: randomUUID(),
    };

    await superDb.insert(users).values({
      id: tenantA.userId,
      name: "RLS Wiring Gate User",
      walletAddress: generateTestWallet("rls-gate"),
    });

    await superDb.insert(billingAccounts).values({
      id: tenantA.billingAccountId,
      ownerUserId: tenantA.userId,
      balanceCredits: 100_000_000n,
    });

    await superDb.insert(virtualKeys).values({
      billingAccountId: tenantA.billingAccountId,
      label: "RLS Gate Default",
      isDefault: true,
      active: true,
    });

    await superDb.insert(executionGrants).values({
      id: tenantA.executionGrantId,
      userId: tenantA.userId,
      billingAccountId: tenantA.billingAccountId,
      scopes: ["graph:execute:test:rls-gate"],
    });

    await superDb.insert(schedules).values({
      id: tenantA.scheduleId,
      ownerUserId: tenantA.userId,
      executionGrantId: tenantA.executionGrantId,
      graphId: "test:rls-gate",
      input: { test: true },
      cron: "0 0 * * *",
      timezone: "UTC",
      enabled: true,
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
  });

  afterAll(async () => {
    // CASCADE from users handles child rows
    await superDb.delete(users).where(eq(users.id, tenantA.userId));
  });

  // ── Sanity: prove seeded data exists via superuser ────────────

  describe("sanity: data visible via superuser", () => {
    it("superuser reads the seeded schedule", async () => {
      const rows = await superDb.query.schedules.findMany({
        where: eq(schedules.id, tenantA.scheduleId),
      });
      expect(rows).toHaveLength(1);
    });

    it("superuser reads the seeded billing account", async () => {
      const rows = await superDb.query.billingAccounts.findMany({
        where: eq(billingAccounts.id, tenantA.billingAccountId),
      });
      expect(rows).toHaveLength(1);
    });
  });

  // ── Wiring gates ──────────────────────────────────────────────
  //
  // These tests call adapter methods directly — NO withTenantScope wrapper.
  // The adapter must internally call setTenantContext to pass.

  describe("DrizzleScheduleUserAdapter", () => {
    let adapter: DrizzleScheduleUserAdapter;

    beforeAll(() => {
      // listSchedules only uses this.db — stubs are never called
      // biome-ignore lint/suspicious/noExplicitAny: test stubs for unused ports
      adapter = new DrizzleScheduleUserAdapter(rlsDb, {} as any, {} as any);
    });

    it("listSchedules returns schedules for the calling user", async () => {
      const result = await adapter.listSchedules(toUserId(tenantA.userId));
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]?.ownerUserId).toBe(tenantA.userId);
    });
  });

  describe("UserDrizzleAccountService", () => {
    let service: UserDrizzleAccountService;

    beforeAll(() => {
      service = new UserDrizzleAccountService(rlsDb, toUserId(tenantA.userId));
    });

    it("getOrCreateBillingAccountForUser returns account for existing user", async () => {
      const result = await service.getOrCreateBillingAccountForUser({
        userId: tenantA.userId,
      });
      expect(result.ownerUserId).toBe(tenantA.userId);
    });
  });

  describe("UserDrizzlePaymentAttemptRepository", () => {
    let repo: UserDrizzlePaymentAttemptRepository;

    beforeAll(() => {
      repo = new UserDrizzlePaymentAttemptRepository(
        rlsDb,
        toUserId(tenantA.userId)
      );
    });

    it("create succeeds for correct tenant under RLS", async () => {
      const attempt = await repo.create({
        billingAccountId: tenantA.billingAccountId,
        fromAddress: generateTestWallet("rls-gate-pay"),
        chainId: 84532,
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        amountRaw: 5_000_000n,
        amountUsdCents: 500,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(attempt.id).toBeDefined();
      expect(attempt.status).toBe("CREATED_INTENT");
      expect(attempt.billingAccountId).toBe(tenantA.billingAccountId);

      // Cleanup
      await superDb
        .delete(paymentAttempts)
        .where(eq(paymentAttempts.id, attempt.id));
    });

    it("findById returns null for other-tenant attempt", async () => {
      // Seed an attempt via superuser for a different billing account
      const otherUserId = randomUUID();
      const otherBillingAccountId = randomUUID();

      await superDb.insert(users).values({
        id: otherUserId,
        name: "RLS Gate Other User",
        walletAddress: generateTestWallet("rls-gate-other"),
      });
      await superDb.insert(billingAccounts).values({
        id: otherBillingAccountId,
        ownerUserId: otherUserId,
        balanceCredits: 0n,
      });
      const [otherAttempt] = await superDb
        .insert(paymentAttempts)
        .values({
          billingAccountId: otherBillingAccountId,
          fromAddress: generateTestWallet("rls-gate-other-pay"),
          chainId: 84532,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          status: "CREATED_INTENT",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        })
        .returning({ id: paymentAttempts.id });

      // tenantA's repo cannot see otherUser's attempt
      if (!otherAttempt) throw new Error("Expected otherAttempt to be defined");
      const result = await repo.findById(
        otherAttempt.id,
        otherBillingAccountId
      );
      expect(result).toBeNull();

      // Cleanup (CASCADE from users)
      await superDb.delete(users).where(eq(users.id, otherUserId));
    });
  });
});
