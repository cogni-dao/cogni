// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/payments/mvp-scenarios`
 * Purpose: Stack tests for 9 critical MVP payment scenarios from PAYMENTS_DESIGN.md:72-82.
 * Scope: Tests full vertical slice (facade → service → ports → DB) with real production code and configured FakeOnChainVerifierAdapter. Does not bypass ports with mocks.
 * Invariants: All 9 MVP scenarios pass; bidirectional invariant (CREDITED ↔ ledger) holds; no flaky tests.
 * Side-effects: IO (database writes, facade calls)
 * Notes: Uses singleton FakeOnChainVerifierAdapter via getTestOnChainVerifier(); resets in beforeEach/afterEach.
 * Links: docs/spec/payments-design.md, docs/spec/payments-design.md
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import { CHAIN_ID } from "@cogni/node-shared";
import { makeTestCtx } from "@tests/_fakes";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTestOnChainVerifier,
  resetTestOnChainVerifier,
} from "@/adapters/test";
import {
  createPaymentIntentFacade,
  getPaymentStatusFacade,
  submitPaymentTxHashFacade,
} from "@/app/_facades/payments/attempts.server";
import { creditLedger, paymentAttempts } from "@/shared/db/schema";

describe("MVP Payment Scenarios (9 critical flows)", () => {
  let testUserId: string;
  let testUser2Id: string;
  let testBillingAccountId: string;
  let sessionUser: SessionUser;
  let sessionUser2: SessionUser;
  const db = getSeedDb();

  beforeEach(async () => {
    // Reset fake adapter to default VERIFIED state
    resetTestOnChainVerifier();

    // Seed test user 1 with billing account + virtual key
    // walletAddress is auto-generated via generateTestWallet() to avoid cross-file collisions
    const seeded1 = await seedAuthenticatedUser(db, {
      id: randomUUID(),
      name: "Test User 1",
    });

    testUserId = seeded1.user.id;
    testBillingAccountId = seeded1.billingAccount.id;
    if (!seeded1.user.walletAddress) {
      throw new Error("Test user 1 missing wallet address");
    }
    sessionUser = {
      id: seeded1.user.id,
      walletAddress: seeded1.user.walletAddress,
    };

    // Seed test user 2 (for ownership tests)
    const seeded2 = await seedAuthenticatedUser(db, {
      id: randomUUID(),
      name: "Test User 2",
    });

    testUser2Id = seeded2.user.id;
    if (!seeded2.user.walletAddress) {
      throw new Error("Test user 2 missing wallet address");
    }
    sessionUser2 = {
      id: seeded2.user.id,
      walletAddress: seeded2.user.walletAddress,
    };
  });

  afterEach(async () => {
    // Cleanup cascades to billing/ledger/payment_attempts via FK
    // Guard against undefined IDs when beforeEach fails partway through
    const { users } = await import("@/shared/db/schema");
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
    if (testUser2Id) {
      await db.delete(users).where(eq(users.id, testUser2Id));
    }

    // Reset fake adapter state
    resetTestOnChainVerifier();
  });

  describe("Scenario 1: Sender mismatch → REJECTED with SENDER_MISMATCH", () => {
    it("rejects payment when sender doesn't match session wallet", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();

      // Configure verifier to return VERIFIED but with different sender
      verifier.setVerified({
        actualFrom: `0x${"9".repeat(40)}`, // Different from session wallet
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Create intent
      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      expect(intent.attemptId).toBeDefined();
      expect(intent.chainId).toBe(CHAIN_ID);

      // Submit txHash - should be REJECTED due to sender mismatch
      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xabc123",
        },
        ctx
      );

      // Assert response
      expect(result.status).toBe("REJECTED");
      expect(result.errorCode).toBe("SENDER_MISMATCH");
      expect(result.txHash).toBe("0xabc123");

      // Assert no credit_ledger entry for test user
      const ledger = await db.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xabc123`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledger).toBeUndefined();

      // Assert DB state
      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });
      expect(attempt?.status).toBe("REJECTED");
      expect(attempt?.errorCode).toBe("SENDER_MISMATCH");
    });
  });

  describe("Scenario 2: Wrong token/recipient/amount → REJECTED", () => {
    it("rejects payment with insufficient amount", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();

      // Configure verifier to fail with INSUFFICIENT_AMOUNT
      verifier.setFailed("INSUFFICIENT_AMOUNT");

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xdef456",
        },
        ctx
      );

      // Assert REJECTED with error code
      expect(result.status).toBe("REJECTED");
      expect(result.errorCode).toBe("INSUFFICIENT_AMOUNT");

      // Assert no credit_ledger entry for test user
      const ledger = await db.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xdef456`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledger).toBeUndefined();
    });

    it("rejects payment with wrong token", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setFailed("INVALID_TOKEN");

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0x789abc",
        },
        ctx
      );

      expect(result.status).toBe("REJECTED");
      expect(result.errorCode).toBe("INVALID_TOKEN");
    });
  });

  describe("Scenario 3: Missing receipt → stays PENDING_UNVERIFIED", () => {
    it("stays PENDING_UNVERIFIED when receipt not found", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();

      // Configure verifier to return PENDING (not indexed yet)
      verifier.setPending();

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xpending123",
        },
        ctx
      );

      // Assert PENDING_UNVERIFIED
      expect(result.status).toBe("PENDING_UNVERIFIED");
      expect(result.errorCode).toBeUndefined();

      // Verify stays PENDING on subsequent getStatus calls (within 24h)
      const status = await getPaymentStatusFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
        },
        ctx
      );
      expect(status.status).toBe("PENDING_VERIFICATION"); // Client-visible status
    });
  });

  describe("Scenario 4: PENDING_UNVERIFIED timeout → FAILED with RECEIPT_NOT_FOUND", () => {
    it("transitions to FAILED after 24h timeout", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setPending();

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xtimeout123",
        },
        ctx
      );

      expect(result.status).toBe("PENDING_UNVERIFIED");

      // Manually update submittedAt to 24h ago in DB
      await db
        .update(paymentAttempts)
        .set({ submittedAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000) })
        .where(eq(paymentAttempts.id, intent.attemptId));

      // getStatus should detect timeout and transition to FAILED
      const status = await getPaymentStatusFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
        },
        ctx
      );

      expect(status.status).toBe("FAILED"); // Client-visible status
      expect(status.errorCode).toBe("RECEIPT_NOT_FOUND");

      // Verify DB state
      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });
      expect(attempt?.status).toBe("FAILED");
      expect(attempt?.errorCode).toBe("RECEIPT_NOT_FOUND");
    });
  });

  describe("Scenario 5: Insufficient confirmations → PENDING then CREDITED", () => {
    it("stays PENDING_UNVERIFIED then transitions to CREDITED when verified", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();

      // NOTE: Current MVP stub doesn't check confirmations - it always returns VERIFIED.
      // This test documents expected Phase 3 behavior when Ponder verification is real.
      // For now, we test the scenario by having verifier return PENDING first, then VERIFIED.

      // First call: verifier returns PENDING (simulating insufficient confirmations)
      verifier.setPending();

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result1 = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xconfirm123",
        },
        ctx
      );

      expect(result1.status).toBe("PENDING_UNVERIFIED");

      // Second call: verifier returns VERIFIED (simulating confirmations reached MIN_CONFIRMATIONS)
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS from adapter
      });

      const result2 = await getPaymentStatusFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
        },
        ctx
      );

      expect(result2.status).toBe("CONFIRMED"); // Client-visible status for CREDITED

      // Verify user's ledger entry exists (scoped to test user's billing account)
      const ledger = await db.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xconfirm123`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledger).toBeTruthy();
      expect(Number(ledger?.amount)).toBe(50_000_000); // $5 * 10,000,000 credits/USD
    });
  });

  describe("Scenario 6: Duplicate submit (same attempt+hash) → 200 Idempotent", () => {
    it("returns existing status for duplicate submit (idempotent)", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      // First submit
      const result1 = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xidempotent123",
        },
        ctx
      );

      // Second submit with SAME hash - should be idempotent
      const result2 = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xidempotent123",
        },
        ctx
      );

      expect(result2.status).toBe(result1.status);
      expect(result2.txHash).toBe(result1.txHash);

      // Verify only one user ledger entry exists (idempotency; exclude system tenant revenue share)
      const ledgerEntries = await db.query.creditLedger.findMany({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xidempotent123`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledgerEntries).toHaveLength(1);
    });
  });

  describe("Scenario 7: Same txHash different attempt → 409 Conflict", () => {
    it("rejects duplicate txHash on different attempt", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Create first attempt and bind hash
      const intent1 = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent1.attemptId,
          txHash: "0xduplicate123",
        },
        ctx
      );

      // Create second attempt and try to use same hash
      const intent2 = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      // Should throw TxHashAlreadyBoundPortError
      await expect(
        submitPaymentTxHashFacade(
          {
            sessionUser,
            attemptId: intent2.attemptId,
            txHash: "0xduplicate123",
          },
          ctx
        )
      ).rejects.toThrow();

      // Verify only one user ledger entry exists (first attempt only; exclude system tenant revenue share)
      const ledgerEntries = await db.query.creditLedger.findMany({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xduplicate123`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledgerEntries).toHaveLength(1);
    });
  });

  describe("Scenario 8: Atomic settle → Bidirectional invariant (CREDITED ↔ ledger)", () => {
    it("ensures atomicity: CREDITED status always has matching ledger entry", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xatomic123",
        },
        ctx
      );

      // Bidirectional invariant: CREDITED ↔ user ledger entry (scoped to test user's billing account)
      const ledger = await db.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xatomic123`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });

      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });

      if (attempt?.status === "CREDITED") {
        // If CREDITED, ledger MUST exist with correct amount
        expect(ledger).toBeTruthy();
        expect(Number(ledger?.amount)).toBe(50_000_000); // $5 * 10,000,000 credits/USD
        expect(ledger?.reason).toBe("widget_payment");
      } else {
        // If not CREDITED, ledger MUST NOT exist
        expect(ledger).toBeUndefined();
      }
    });

    it("ensures atomicity: non-CREDITED attempts have no ledger entry", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();

      // Configure verifier to reject (sender mismatch)
      verifier.setVerified({
        actualFrom: `0x${"9".repeat(40)}`, // Different from session wallet
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0xrejected456",
        },
        ctx
      );

      expect(result.status).toBe("REJECTED");

      // No ledger entry for rejected payment
      const ledger = await db.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0xrejected456`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });
      expect(ledger).toBeUndefined();

      // Verify DB state
      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });
      expect(attempt?.status).toBe("REJECTED");
    });
  });

  describe("Scenario 9: Ownership enforcement → not owned returns error", () => {
    it("enforces ownership: returns error for not-owned attempt", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Create attempt with user1
      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents: 500,
        },
        ctx
      );

      // Try to access with user2 - should fail
      await expect(
        getPaymentStatusFacade(
          {
            sessionUser: sessionUser2,
            attemptId: intent.attemptId,
          },
          ctx
        )
      ).rejects.toThrow("not found");

      // Try to submit with user2 - should fail
      await expect(
        submitPaymentTxHashFacade(
          {
            sessionUser: sessionUser2,
            attemptId: intent.attemptId,
            txHash: "0xownership123",
          },
          ctx
        )
      ).rejects.toThrow("not found");
    });
  });
});
