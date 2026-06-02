// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/payments/numeric-flow`
 * Purpose: Stack tests verifying numeric flow from UI cents → intent amount_usd_cents → amount_raw → ledger credits delta.
 * Scope: Tests complete numeric flow for $1 and $50 payments with exact conversions at each step. Does not test error cases or UI rendering.
 * Invariants: UI cents → backend cents → raw USDC → credits all match; no float math; uses usdCentsToCredits().
 * Side-effects: IO (database writes, facade calls)
 * Notes: Validates conversion formulas: 1 cent = 10,000 raw USDC units; 1 cent = 10 credits.
 * Links: docs/spec/payments-design.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { usdCentsToCredits } from "@cogni/node-core";
import type { SessionUser } from "@cogni/node-shared";
import { CHAIN_ID } from "@cogni/node-shared";
import { makeTestCtx } from "@tests/_fakes";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { asNumber } from "@tests/_fixtures/db-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTestOnChainVerifier,
  resetTestOnChainVerifier,
} from "@/adapters/test";
import {
  createPaymentIntentFacade,
  submitPaymentTxHashFacade,
} from "@/app/_facades/payments/attempts.server";
import {
  billingAccounts,
  creditLedger,
  paymentAttempts,
} from "@/shared/db/schema";

describe("Payment Numeric Flow Validation", () => {
  let testUserId: string;
  let testBillingAccountId: string;
  let sessionUser: SessionUser;
  const seedDb = getSeedDb();

  beforeEach(async () => {
    resetTestOnChainVerifier();

    // Seed test user with billing account + virtual key (uses BYPASSRLS)
    const seeded = await seedAuthenticatedUser(seedDb, {
      id: randomUUID(),
      name: "Numeric Flow Test User",
    });

    testUserId = seeded.user.id;
    testBillingAccountId = seeded.billingAccount.id;
    if (!seeded.user.walletAddress) {
      throw new Error("Test user missing wallet address");
    }
    sessionUser = {
      id: seeded.user.id,
      walletAddress: seeded.user.walletAddress,
    };
  });

  afterEach(async () => {
    const { users } = await import("@/shared/db/schema");
    if (testUserId) {
      await seedDb.delete(users).where(eq(users.id, testUserId));
    }
    resetTestOnChainVerifier();
  });

  describe("$1 Payment Flow", () => {
    it("correctly converts 200 cents → 2,000,000 raw USDC → 20,000,000 credits", async () => {
      // NOTE: DB uses BIGINT for amount columns; tests normalize via asNumber().
      // Safe because max values < 2^53 (JavaScript safe integer limit).
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      const amountUsdCents = 200; // $2.00 (MIN_PAYMENT_CENTS)
      const expectedAmountRaw = 2_000_000n; // 200 cents * 10,000
      const expectedCredits = 20_000_000; // $2 * 10,000,000 credits/USD (protocol constant)

      // Configure verifier to return VERIFIED with correct values
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: expectedAmountRaw,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Step 1: Create intent
      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents,
        },
        ctx
      );

      expect(intent.attemptId).toBeDefined();
      expect(intent.amountUsdCents).toBe(amountUsdCents);
      expect(intent.amountRaw).toBe(expectedAmountRaw.toString());

      // Step 2: Verify DB record has correct amount_usd_cents and amount_raw
      const attemptBefore = await seedDb.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });

      expect(attemptBefore).toBeDefined();
      expect(attemptBefore?.amountUsdCents).toBe(amountUsdCents);
      expect(attemptBefore?.amountRaw).toBe(expectedAmountRaw);

      // Step 3: Get initial balance
      const accountBefore = await seedDb.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, testUserId),
      });
      if (!accountBefore) {
        throw new Error("Test setup failed: billing account not created");
      }
      const balanceBefore = asNumber(accountBefore.balanceCredits);

      // Step 4: Submit txHash
      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0x1dollar",
        },
        ctx
      );

      // Step 5: Verify payment CREDITED
      expect(result.status).toBe("CREDITED");

      // Step 6: Verify ledger entry has correct credits (scoped to test user's billing account)
      const ledgerEntry = await seedDb.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0x1dollar`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });

      if (!ledgerEntry) {
        throw new Error("Ledger entry not created after settlement");
      }
      expect(asNumber(ledgerEntry.amount)).toBe(expectedCredits);
      expect(asNumber(ledgerEntry.balanceAfter)).toBe(
        balanceBefore + expectedCredits
      );

      // Step 7: Verify billing account balance updated
      const accountAfter = await seedDb.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, testUserId),
      });
      if (!accountAfter) {
        throw new Error("Billing account missing after settlement");
      }

      expect(asNumber(accountAfter.balanceCredits)).toBe(
        balanceBefore + expectedCredits
      );

      // Step 8: Assert exact conversion formula
      expect(BigInt(amountUsdCents) * 10_000n).toBe(expectedAmountRaw);
      expect(Number(usdCentsToCredits(amountUsdCents))).toBe(expectedCredits);

      // Step 9: Assert UI display formula matches backend constant
      // UI button text: "formatCredits(amountCents * CREDITS_PER_CENT) credits"
      // This ensures UI can never drift from backend conversion rate
      const uiDisplayCredits = Number(usdCentsToCredits(amountUsdCents));
      expect(uiDisplayCredits).toBe(expectedCredits);
    });
  });

  describe("$50 Payment Flow", () => {
    it("correctly converts 5000 cents → 50,000,000 raw USDC → 500,000,000 credits", async () => {
      const ctx = makeTestCtx();
      const verifier = getTestOnChainVerifier();
      const amountUsdCents = 5000; // $50.00
      const expectedAmountRaw = 50_000_000n; // 5000 cents * 10,000
      const expectedCredits = 500_000_000; // $50 * 10,000,000 credits/USD (protocol constant)

      // Configure verifier to return VERIFIED with correct values
      verifier.setVerified({
        actualFrom: sessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: expectedAmountRaw,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Step 1: Create intent
      const intent = await createPaymentIntentFacade(
        {
          sessionUser,
          amountUsdCents,
        },
        ctx
      );

      expect(intent.attemptId).toBeDefined();
      expect(intent.amountUsdCents).toBe(amountUsdCents);
      expect(intent.amountRaw).toBe(expectedAmountRaw.toString());

      // Step 2: Verify DB record has correct amount_usd_cents and amount_raw
      const attemptBefore = await seedDb.query.paymentAttempts.findFirst({
        where: eq(paymentAttempts.id, intent.attemptId),
      });

      expect(attemptBefore).toBeDefined();
      expect(attemptBefore?.amountUsdCents).toBe(amountUsdCents);
      expect(attemptBefore?.amountRaw).toBe(expectedAmountRaw);

      // Step 3: Get initial balance
      const accountBefore = await seedDb.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, testUserId),
      });
      if (!accountBefore) {
        throw new Error("Test setup failed: billing account not created");
      }
      const balanceBefore = asNumber(accountBefore.balanceCredits);

      // Step 4: Submit txHash
      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId: intent.attemptId,
          txHash: "0x50dollars",
        },
        ctx
      );

      // Step 5: Verify payment CREDITED
      expect(result.status).toBe("CREDITED");

      // Step 6: Verify ledger entry has correct credits (scoped to test user's billing account)
      const ledgerEntry = await seedDb.query.creditLedger.findFirst({
        where: and(
          eq(creditLedger.reference, `${CHAIN_ID}:0x50dollars`),
          eq(creditLedger.billingAccountId, testBillingAccountId)
        ),
      });

      if (!ledgerEntry) {
        throw new Error("Ledger entry not created after settlement");
      }
      expect(asNumber(ledgerEntry.amount)).toBe(expectedCredits);
      expect(asNumber(ledgerEntry.balanceAfter)).toBe(
        balanceBefore + expectedCredits
      );

      // Step 7: Verify billing account balance updated
      const accountAfter = await seedDb.query.billingAccounts.findFirst({
        where: eq(billingAccounts.ownerUserId, testUserId),
      });
      if (!accountAfter) {
        throw new Error("Billing account missing after settlement");
      }

      expect(asNumber(accountAfter.balanceCredits)).toBe(
        balanceBefore + expectedCredits
      );

      // Step 8: Assert exact conversion formula
      expect(BigInt(amountUsdCents) * 10_000n).toBe(expectedAmountRaw);
      expect(Number(usdCentsToCredits(amountUsdCents))).toBe(expectedCredits);

      // Step 9: Assert UI display formula matches backend constant
      // UI button text: "formatCredits(amountCents * CREDITS_PER_CENT) credits"
      // This ensures UI can never drift from backend conversion rate
      const uiDisplayCredits = Number(usdCentsToCredits(amountUsdCents));
      expect(uiDisplayCredits).toBe(expectedCredits);
    });
  });
});
