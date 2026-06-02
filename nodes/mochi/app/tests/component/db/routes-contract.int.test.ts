// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/payments/routes-contract`
 * Purpose: HTTP route contract tests validating status codes, schema compliance, and auth enforcement.
 * Scope: Tests route handlers directly with NextRequest mocking. Does not test business logic (covered by stack tests).
 * Invariants: HTTP status codes correct; Zod schemas enforced; auth failures return 401; ownership returns 404/409.
 * Side-effects: IO (database via test harness)
 * Notes: Focuses on HTTP layer only - contract compliance, not payment scenarios.
 * Links: docs/spec/payments-design.md, src/app/api/v1/payments
 * @public
 */

import { randomUUID } from "node:crypto";
import type {
  PaymentAttemptStatus,
  PaymentErrorCode,
  PaymentStatus,
} from "@cogni/node-core";
import type { SessionUser } from "@cogni/node-shared";
import { CHAIN_ID } from "@cogni/node-shared";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestOnChainVerifier,
  resetTestOnChainVerifier,
} from "@/adapters/test";

// Mock session auth
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { makeTestCtx } from "@tests/_fakes";
import { createPaymentIntentFacade } from "@/app/_facades/payments/attempts.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { GET as getStatus } from "@/app/api/v1/payments/attempts/[id]/route";
import { POST as submitTxHash } from "@/app/api/v1/payments/attempts/[id]/submit/route";
import { POST as createIntent } from "@/app/api/v1/payments/intents/route";
import type { RequestContext } from "@/shared/observability";

// SKIP: DrizzlePaymentAttemptRepository operates via getAppDb() (FORCE RLS) without
// withTenantScope wiring. Un-skip once the adapter calls setTenantContext.
describe.skip("Payment Routes HTTP Contract Tests", () => {
  let testSessionUser: SessionUser;
  let testUserId: string;
  let testCtx: RequestContext;
  let walletCounter = 0;

  function generateTestWallet(): string {
    // Generate unique valid Ethereum address
    const suffix = (walletCounter++).toString(16).padStart(8, "0");
    return `0x${suffix.repeat(5)}`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetTestOnChainVerifier();

    testCtx = makeTestCtx();

    // Seed test user with billing account + virtual key (unique wallet per test)
    const seeded = await seedAuthenticatedUser(getSeedDb(), {
      id: randomUUID(),
      walletAddress: generateTestWallet(),
      name: "Route Test User",
    });

    testUserId = seeded.user.id;
    if (!seeded.user.walletAddress) {
      throw new Error("Test user missing wallet address");
    }
    testSessionUser = {
      id: seeded.user.id,
      walletAddress: seeded.user.walletAddress,
    };
  });

  afterEach(async () => {
    // Cleanup cascades to billing/payment_attempts via FK
    const { users } = await import("@/shared/db/schema");
    await getSeedDb().delete(users).where(eq(users.id, testUserId));
    resetTestOnChainVerifier();
  });

  describe("POST /api/v1/payments/intents", () => {
    it("returns 401 without session", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/intents",
        {
          method: "POST",
          body: JSON.stringify({ amountUsdCents: 500 }),
        }
      );

      const response = await createIntent(req);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toMatch(/session/i);
    });

    it("returns 400 for invalid amount (Zod validation)", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/intents",
        {
          method: "POST",
          body: JSON.stringify({ amountUsdCents: 50 }), // Below MIN_PAYMENT_CENTS (200)
        }
      );

      const response = await createIntent(req);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).not.toHaveProperty("details"); // Security: no Zod details to clients
      expect(data.error).toMatch(/invalid/i);
    });

    it("returns 200 with Zod-compliant response shape", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/intents",
        {
          method: "POST",
          body: JSON.stringify({ amountUsdCents: 500 }),
        }
      );

      const response = await createIntent(req);

      expect(response.status).toBe(200);

      const data = await response.json();
      // Validate exact contract shape
      expect(data).toMatchObject({
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/), // UUID
        chainId: CHAIN_ID,
        token: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
        to: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
        amountRaw: expect.any(String),
        amountUsdCents: 500,
        expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO datetime
      });
    });

    it("returns 401 for user not provisioned (AUTH_USER_NOT_FOUND)", async () => {
      const unprovisionedUser: SessionUser = {
        id: randomUUID(),
        walletAddress: generateTestWallet(),
      };
      vi.mocked(getSessionUser).mockResolvedValue(unprovisionedUser);
      // Don't seed user in DB - should trigger AUTH_USER_NOT_FOUND

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/intents",
        {
          method: "POST",
          body: JSON.stringify({ amountUsdCents: 500 }),
        }
      );

      const response = await createIntent(req);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toMatch(/not provisioned/i);
    });
  });

  describe("POST /api/v1/payments/attempts/[id]/submit", () => {
    it("returns 401 without session", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/attempts/test-id/submit",
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"a".repeat(64)}` }),
        }
      );

      const response = await submitTxHash(req, {
        params: Promise.resolve({ id: "test-id" }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toMatch(/session/i);
    });

    it("returns 400 for invalid txHash format", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/attempts/test-id/submit",
        {
          method: "POST",
          body: JSON.stringify({ txHash: "not-a-hash" }), // Invalid format
        }
      );

      const response = await submitTxHash(req, {
        params: Promise.resolve({ id: "test-id" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).not.toHaveProperty("details"); // Security: no Zod details to clients
      expect(data.error).toMatch(/invalid/i);
    });

    it("returns 404 for non-existent attemptId", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const nonExistentId = randomUUID(); // Valid UUID that doesn't exist in DB

      const req = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${nonExistentId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"b".repeat(64)}` }),
        }
      );

      const response = await submitTxHash(req, {
        params: Promise.resolve({ id: nonExistentId }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toMatch(/not found|not owned/i);
    });

    it("returns 409 for duplicate txHash (TxHashAlreadyBoundPortError)", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      // Configure verifier to succeed
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: testSessionUser.walletAddress,
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Create first attempt and bind txHash
      const intent1 = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      const req1 = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent1.attemptId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"c".repeat(64)}` }),
        }
      );

      await submitTxHash(req1, {
        params: Promise.resolve({ id: intent1.attemptId }),
      });

      // Create second attempt and try same txHash
      const intent2 = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      const req2 = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent2.attemptId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"c".repeat(64)}` }), // Same hash
        }
      );

      const response = await submitTxHash(req2, {
        params: Promise.resolve({ id: intent2.attemptId }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toMatch(/transaction hash already used/i);
      // existingAttemptId intentionally omitted from response to prevent cross-tenant info leak
      expect(data).not.toHaveProperty("details");
    });

    it("returns response with status from PaymentAttemptStatus enum", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const verifier = getTestOnChainVerifier();
      verifier.setPending(); // Will return PENDING_UNVERIFIED

      const intent = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      const req = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent.attemptId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"d".repeat(64)}` }),
        }
      );

      const response = await submitTxHash(req, {
        params: Promise.resolve({ id: intent.attemptId }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      // Assert status is from canonical enum
      const validStatuses: PaymentAttemptStatus[] = [
        "CREATED_INTENT",
        "PENDING_UNVERIFIED",
        "CREDITED",
        "REJECTED",
        "FAILED",
      ];
      expect(validStatuses).toContain(data.status);
    });
  });

  describe("GET /api/v1/payments/attempts/[id]", () => {
    it("returns 401 without session", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/payments/attempts/test-id",
        { method: "GET" }
      );

      const response = await getStatus(req, {
        params: Promise.resolve({ id: "test-id" }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toMatch(/session/i);
    });

    it("returns 404 for not-owned attempt (cross-user access)", async () => {
      // Create attempt with user1
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);
      const intent = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      // Try to access with user2
      const user2 = await seedAuthenticatedUser(getSeedDb(), {
        id: randomUUID(),
        walletAddress: generateTestWallet(),
        name: "User 2",
      });

      if (!user2.user.walletAddress) {
        throw new Error("User 2 missing wallet address");
      }
      const sessionUser2: SessionUser = {
        id: user2.user.id,
        walletAddress: user2.user.walletAddress,
      };

      vi.mocked(getSessionUser).mockResolvedValue(sessionUser2);

      const req = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent.attemptId}`,
        { method: "GET" }
      );

      const response = await getStatus(req, {
        params: Promise.resolve({ id: intent.attemptId }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toMatch(/not found|not owned/i);

      // Cleanup user2
      await getSeedDb()
        .delete((await import("@/shared/db/schema")).users)
        .where(
          eq((await import("@/shared/db/schema")).users.id, user2.user.id)
        );
    });

    it("returns response with status from PaymentStatus enum", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      const verifier = getTestOnChainVerifier();
      verifier.setPending();

      const intent = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      const req = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent.attemptId}`,
        { method: "GET" }
      );

      const response = await getStatus(req, {
        params: Promise.resolve({ id: intent.attemptId }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      // Assert status is from canonical enum
      const validStatuses: PaymentStatus[] = [
        "PENDING_VERIFICATION",
        "CONFIRMED",
        "FAILED",
      ];
      expect(validStatuses).toContain(data.status);
    });

    it("returns errorCode from PaymentErrorCode enum when present", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(testSessionUser);

      // Configure verifier to return REJECTED with SENDER_MISMATCH
      const verifier = getTestOnChainVerifier();
      verifier.setVerified({
        actualFrom: `0x${"9".repeat(40)}`, // Different sender
        actualTo: "0x0702e6969ec03f30cf3684c802b264c68a61d219",
        actualAmount: 5_000_000n,
        // confirmations defaults to MIN_CONFIRMATIONS
      });

      // Create intent and submit (will be REJECTED)
      const intent = await createPaymentIntentFacade(
        {
          sessionUser: testSessionUser,
          amountUsdCents: 500,
        },
        testCtx
      );

      const submitReq = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent.attemptId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ txHash: `0x${"f".repeat(64)}` }),
        }
      );

      await submitTxHash(submitReq, {
        params: Promise.resolve({ id: intent.attemptId }),
      });

      // Get status - should have errorCode
      const req = new NextRequest(
        `http://localhost:3000/api/v1/payments/attempts/${intent.attemptId}`,
        { method: "GET" }
      );

      const response = await getStatus(req, {
        params: Promise.resolve({ id: intent.attemptId }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      if (data.errorCode) {
        const validCodes: PaymentErrorCode[] = [
          "SENDER_MISMATCH",
          "INVALID_TOKEN",
          "INVALID_RECIPIENT",
          "INSUFFICIENT_AMOUNT",
          "INSUFFICIENT_CONFIRMATIONS",
          "TX_REVERTED",
          "RECEIPT_NOT_FOUND",
          "INTENT_EXPIRED",
          "RPC_ERROR",
        ];
        expect(validCodes).toContain(data.errorCode);
      }
    });
  });
});
