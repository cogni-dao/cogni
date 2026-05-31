// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ports/harness/payment-attempt.port`
 * Purpose: Shared contract tests for PaymentAttemptUserRepository + PaymentAttemptServiceRepository ensuring consistent behavior across adapters.
 * Scope: Tests repository invariants (ownership, uniqueness, state transitions). Does not test service logic or credit settlement.
 * Invariants: Ownership enforcement, txHash uniqueness, audit logging, state persistence.
 * Side-effects: IO (database operations via test harness)
 * Notes: Called from adapter specs; tests invariants not implementation details.
 * Links: PaymentAttemptUserRepository + PaymentAttemptServiceRepository ports, drizzle-payment-attempt.adapter.int.test.ts
 * @internal
 */

import { randomUUID } from "node:crypto";
import { CHAIN_ID } from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CreatePaymentAttemptParams,
  PaymentAttemptServiceRepository,
  PaymentAttemptUserRepository,
} from "@/ports";
import { isTxHashAlreadyBoundPortError } from "@/ports";
import { billingAccounts, users } from "@/shared/db/schema";

import { dispose, makeHarness, type TestHarness } from "./factory";

/**
 * Register PaymentAttempt port contract tests.
 * Adapter specs call this with factories for user-scoped and service-scoped repos.
 *
 * @param makeUserRepo - Factory receiving userId (known after seed) + harness; returns user-scoped repo
 * @param makeServiceRepo - Factory receiving harness; returns service-scoped repo (BYPASSRLS)
 */
export function registerPaymentAttemptRepositoryContract(
  makeUserRepo: (
    userId: string,
    h: TestHarness
  ) => Promise<PaymentAttemptUserRepository>,
  makeServiceRepo: (h: TestHarness) => Promise<PaymentAttemptServiceRepository>
): void {
  describe("PaymentAttempt Port Contract", () => {
    let h: TestHarness;
    let userRepo: PaymentAttemptUserRepository;
    let serviceRepo: PaymentAttemptServiceRepository;
    let testUserId: string;
    let testBillingAccountId: string;
    let testUser2Id: string;
    let testBillingAccount2Id: string;

    beforeAll(async () => {
      h = await makeHarness();

      // Create test users and billing accounts for FK constraints
      const seedDb = getSeedDb();

      // Create first user
      testUserId = randomUUID();
      await seedDb.insert(users).values({
        id: testUserId,
        walletAddress: `0x${"1".repeat(40)}`,
        name: "Test User 1",
      });

      // Create first billing account with explicit ID
      const [billingAccount] = await seedDb
        .insert(billingAccounts)
        .values({
          id: randomUUID(),
          ownerUserId: testUserId,
          balanceCredits: 0n,
        })
        .returning({ id: billingAccounts.id });

      if (!billingAccount) {
        throw new Error("Failed to create test billing account");
      }
      testBillingAccountId = billingAccount.id;

      // Create second user for ownership tests
      testUser2Id = randomUUID();
      await seedDb.insert(users).values({
        id: testUser2Id,
        walletAddress: `0x${"2".repeat(40)}`,
        name: "Test User 2",
      });

      // Create second billing account with explicit ID
      const [billingAccount2] = await seedDb
        .insert(billingAccounts)
        .values({
          id: randomUUID(),
          ownerUserId: testUser2Id,
          balanceCredits: 0n,
        })
        .returning({ id: billingAccounts.id });

      if (!billingAccount2) {
        throw new Error("Failed to create second test billing account");
      }
      testBillingAccount2Id = billingAccount2.id;

      // Create repos after user IDs are known
      userRepo = await makeUserRepo(testUserId, h);
      serviceRepo = await makeServiceRepo(h);
    });

    afterAll(async () => {
      // Cleanup cascades via FK
      const seedDb = getSeedDb();
      await seedDb.delete(users).where(eq(users.id, testUserId));
      await seedDb.delete(users).where(eq(users.id, testUser2Id));
      await dispose(h);
    });

    describe("User Repository Invariants", () => {
      it("create generates unique ID with CREATED_INTENT status", async () => {
        const params: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const attempt = await userRepo.create(params);

        expect(attempt.id).toBeDefined();
        expect(attempt.status).toBe("CREATED_INTENT");
        expect(attempt.billingAccountId).toBe(params.billingAccountId);
        expect(attempt.fromAddress).toBe(params.fromAddress);
        expect(attempt.txHash).toBeNull();
      });

      it("findById enforces ownership (returns null when not owned)", async () => {
        const params: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const attempt = await userRepo.create(params);

        // Owned query succeeds
        const found = await userRepo.findById(attempt.id, testBillingAccountId);
        expect(found).not.toBeNull();
        expect(found?.id).toBe(attempt.id);

        // Not owned query returns null (RLS + billingAccountId filter)
        const notFound = await userRepo.findById(
          attempt.id,
          testBillingAccount2Id
        );
        expect(notFound).toBeNull();
      });
    });

    describe("Service Repository Invariants", () => {
      it("findByTxHash finds by composite key (chainId, txHash)", async () => {
        const params: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const attempt = await userRepo.create(params);
        const txHash = "0xabc123";
        await serviceRepo.bindTxHash(
          attempt.id,
          attempt.billingAccountId,
          txHash,
          new Date()
        );

        // Find by txHash succeeds
        const found = await serviceRepo.findByTxHash(CHAIN_ID, txHash);
        expect(found).not.toBeNull();
        expect(found?.id).toBe(attempt.id);
        expect(found?.txHash).toBe(txHash);

        // Different chain returns null
        const notFound = await serviceRepo.findByTxHash(11155111, txHash); // Sepolia, not active chain
        expect(notFound).toBeNull();
      });

      it("bindTxHash enforces uniqueness (throws TxHashAlreadyBoundPortError)", async () => {
        const params1: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const params2 = { ...params1 };

        const attempt1 = await userRepo.create(params1);
        const attempt2 = await userRepo.create(params2);

        const txHash = "0xduplicate123";
        const submittedAt = new Date();

        // First bind succeeds
        await serviceRepo.bindTxHash(
          attempt1.id,
          attempt1.billingAccountId,
          txHash,
          submittedAt
        );

        // Second bind with same hash fails
        await expect(
          serviceRepo.bindTxHash(
            attempt2.id,
            attempt2.billingAccountId,
            txHash,
            submittedAt
          )
        ).rejects.toSatisfy(isTxHashAlreadyBoundPortError);
      });

      it("recordVerificationAttempt updates lastVerifyAttemptAt and count", async () => {
        const params: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const attempt = await userRepo.create(params);
        await serviceRepo.bindTxHash(
          attempt.id,
          attempt.billingAccountId,
          "0xabc",
          new Date()
        );

        const attemptedAt = new Date();
        const updated = await serviceRepo.recordVerificationAttempt(
          attempt.id,
          attempt.billingAccountId,
          attemptedAt
        );

        expect(updated.lastVerifyAttemptAt).toEqual(attemptedAt);
        expect(updated.verifyAttemptCount).toBe(1);

        // Second attempt increments count
        const updated2 = await serviceRepo.recordVerificationAttempt(
          attempt.id,
          attempt.billingAccountId,
          new Date()
        );
        expect(updated2.verifyAttemptCount).toBe(2);
      });

      it("updateStatus persists changes correctly", async () => {
        const params: CreatePaymentAttemptParams = {
          billingAccountId: testBillingAccountId,
          fromAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chainId: CHAIN_ID,
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          toAddress: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
          amountRaw: 5_000_000n,
          amountUsdCents: 500,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };

        const attempt = await userRepo.create(params);

        const updated = await serviceRepo.updateStatus(
          attempt.id,
          attempt.billingAccountId,
          "FAILED",
          "INTENT_EXPIRED"
        );

        expect(updated.status).toBe("FAILED");
        expect(updated.errorCode).toBe("INTENT_EXPIRED");

        // Verify persistence via user repo
        const fetched = await userRepo.findById(
          attempt.id,
          params.billingAccountId
        );
        expect(fetched?.status).toBe("FAILED");
        expect(fetched?.errorCode).toBe("INTENT_EXPIRED");
      });
    });
  });
}
