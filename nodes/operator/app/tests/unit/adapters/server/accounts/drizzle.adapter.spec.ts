// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/accounts/drizzle`
 * Purpose: Unit tests for DrizzleAccountService.
 * Scope: Verifies recordChargeReceipt logic per ACTIVITY_METRICS.md. Does not test actual database connection.
 * Invariants:
 * - Post-call never throws InsufficientCreditsPortError; idempotent by (source_system, source_reference)
 * - Test params include required chargeReason, sourceSystem, runId, attempt fields
 * Side-effects: none (uses mocks)
 * Links: `src/adapters/server/accounts/drizzle.adapter.ts`, docs/spec/activity-metrics.md, types/billing.ts
 */

import type { UserId } from "@cogni/ids";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServiceDrizzleAccountService,
  UserDrizzleAccountService,
} from "@/adapters/server/accounts/drizzle.adapter";
import { verifySystemTenant } from "@/bootstrap/healthchecks";

// Mock the db module
const mockTx = {
  query: {
    billingAccounts: {
      findFirst: vi.fn(),
    },
    virtualKeys: {
      findFirst: vi.fn(),
    },
    chargeReceipts: {
      findFirst: vi.fn(),
    },
  },
  execute: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoNothing: vi.fn().mockReturnThis(),
  returning: vi.fn(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  rollback: vi.fn(),
};

const mockDb = {
  transaction: vi.fn((callback) => callback(mockTx)),
  update: vi.fn(() => mockTx),
  query: {
    billingAccounts: {
      findFirst: vi.fn(),
    },
    virtualKeys: {
      findFirst: vi.fn(),
    },
  },
  // biome-ignore lint/suspicious/noExplicitAny: Mocking complex DB type
} as unknown as any; // Cast to any to avoid strict type checks for now

vi.mock("@/adapters/server/db", () => ({
  db: mockDb,
}));

const TEST_USER_ID = "00000000-0000-4000-a000-000000000001" as UserId;

describe("UserDrizzleAccountService", () => {
  let service: UserDrizzleAccountService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.billingAccounts.findFirst.mockReset();
    mockDb.query.virtualKeys.findFirst.mockReset();
    mockDb.update.mockReset().mockReturnValue(mockTx);
    mockTx.query.billingAccounts.findFirst.mockReset();
    mockTx.query.virtualKeys.findFirst.mockReset();
    mockTx.query.chargeReceipts.findFirst.mockReset();
    mockTx.returning.mockReset();
    mockTx.onConflictDoNothing.mockReset().mockReturnThis();
    service = new UserDrizzleAccountService(mockDb, TEST_USER_ID);
  });

  describe("getBillingAccountById", () => {
    it("returns billing account with default virtual key when both exist", async () => {
      // Mock finding account (now inside withTenantScope transaction)
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "acc-123",
        ownerUserId: "user-456",
        balanceCredits: 100000n,
        authorizationOwnerBootstrappedAt: new Date(),
      });

      // Mock finding default virtual key
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({
        id: "vk-789",
        billingAccountId: "acc-123",
        isDefault: true,
      });

      const result = await service.getBillingAccountById("acc-123");

      // withTenantScope must execute SET LOCAL preamble before any queries
      expect(mockTx.execute).toHaveBeenCalledTimes(1);

      expect(result).toEqual({
        id: "acc-123",
        ownerUserId: "user-456",
        balanceCredits: 100000,
        defaultVirtualKeyId: "vk-789",
      });
    });

    it("returns null when billing account not found", async () => {
      mockTx.query.billingAccounts.findFirst.mockResolvedValue(null);

      const result = await service.getBillingAccountById("nonexistent");

      expect(result).toBeNull();
      // Should not attempt to fetch virtual key
      expect(mockTx.query.virtualKeys.findFirst).not.toHaveBeenCalled();
    });

    it("returns null when billing account exists but has no default virtual key", async () => {
      // Mock finding account
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "acc-123",
        ownerUserId: "user-456",
        balanceCredits: 100000n,
        authorizationOwnerBootstrappedAt: new Date(),
      });

      // Mock no default virtual key found
      mockTx.query.virtualKeys.findFirst.mockResolvedValue(null);

      const result = await service.getBillingAccountById("acc-123");

      expect(result).toBeNull();
    });

    it("does not serve an account whose OpenFGA owner bootstrap is pending", async () => {
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "acc-pending",
        ownerUserId: "user-456",
        balanceCredits: 100000n,
        authorizationOwnerBootstrappedAt: null,
      });
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({
        id: "vk-pending",
      });

      await expect(
        service.getBillingAccountById("acc-pending")
      ).rejects.toMatchObject({
        name: "BillingAccountOwnerBootstrapPortError",
        reason: "pending_authority",
      });
    });

    it("reconciles a preexisting system account before readiness serves it", async () => {
      const bootstrapOwner = vi.fn().mockResolvedValue(undefined);
      const serviceAccount = new ServiceDrizzleAccountService(
        mockDb,
        undefined,
        bootstrapOwner
      );
      mockDb.query.billingAccounts.findFirst.mockResolvedValue({
        id: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        ownerUserId: TEST_USER_ID,
        balanceCredits: 0n,
        authorizationOwnerBootstrappedAt: null,
      });
      mockDb.query.virtualKeys.findFirst.mockResolvedValue({
        id: "vk-system",
      });

      await expect(verifySystemTenant(serviceAccount)).resolves.toBeUndefined();
      expect(bootstrapOwner).toHaveBeenCalledWith({
        ownerUserId: TEST_USER_ID,
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
      });
      expect(mockDb.update).toHaveBeenCalledOnce();
    });
  });

  describe("billing-account owner bootstrap", () => {
    it("resumes response loss, then never reprojects after completion", async () => {
      const bootstrapOwner = vi
        .fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValue(undefined);
      service = new UserDrizzleAccountService(
        mockDb,
        TEST_USER_ID,
        undefined,
        bootstrapOwner
      );
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({ id: "vk-owner" });
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "00000000-0000-4000-a000-000000000002",
        ownerUserId: TEST_USER_ID,
        balanceCredits: 0n,
        authorizationOwnerBootstrappedAt: null,
      });

      await expect(
        service.getOrCreateBillingAccountForUser({
          userId: TEST_USER_ID,
          requireAuthorizationOwner: true,
        })
      ).rejects.toThrow("response lost");
      await expect(
        service.getOrCreateBillingAccountForUser({
          userId: TEST_USER_ID,
          requireAuthorizationOwner: true,
        })
      ).resolves.toMatchObject({ ownerUserId: TEST_USER_ID });
      expect(bootstrapOwner).toHaveBeenCalledTimes(2);
      expect(mockTx.update).toHaveBeenCalledTimes(1);

      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "00000000-0000-4000-a000-000000000002",
        ownerUserId: TEST_USER_ID,
        balanceCredits: 0n,
        authorizationOwnerBootstrappedAt: new Date(),
      });
      await service.getOrCreateBillingAccountForUser({
        userId: TEST_USER_ID,
        requireAuthorizationOwner: true,
      });
      expect(bootstrapOwner).toHaveBeenCalledTimes(2);
    });

    it("keeps an account non-serving while authority bootstrap is unavailable", async () => {
      const bootstrapOwner = vi.fn().mockRejectedValue(new Error("offline"));
      service = new UserDrizzleAccountService(
        mockDb,
        TEST_USER_ID,
        undefined,
        bootstrapOwner
      );
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "00000000-0000-4000-a000-000000000002",
        ownerUserId: TEST_USER_ID,
        balanceCredits: 0n,
        authorizationOwnerBootstrappedAt: null,
      });
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({ id: "vk-owner" });

      await expect(
        service.getOrCreateBillingAccountForUser({ userId: TEST_USER_ID })
      ).rejects.toThrow("offline");
      expect(bootstrapOwner).toHaveBeenCalledOnce();
      expect(mockTx.update).not.toHaveBeenCalled();
    });
  });

  describe("recordChargeReceipt", () => {
    // Per GRAPH_EXECUTION.md: run-centric charge_receipt fields
    const params = {
      billingAccountId: "acc-123",
      virtualKeyId: "vk-123",
      runId: "run-123",
      attempt: 0,
      ingressRequestId: "req-123",
      chargedCredits: 2000n,
      responseCostUsd: 0.002,
      litellmCallId: "call-123",
      provenance: "response" as const,
      chargeReason: "llm_usage" as const,
      sourceSystem: "litellm" as const,
      sourceReference: "run-123/0/call-123",
      receiptKind: "llm",
    };

    it("successfully records charge receipt and debits credits", async () => {
      // Mock no existing receipt (new request)
      mockTx.query.chargeReceipts.findFirst.mockResolvedValue(null);

      // Mock finding account with sufficient balance
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "acc-123",
        balanceCredits: 100000n,
        authorizationOwnerBootstrappedAt: new Date(),
      });

      // Mock finding virtual key (required validation)
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({
        id: "vk-123",
        billingAccountId: "acc-123",
      });

      // First .returning() = charge receipt insert (returns id for llm_charge_details FK)
      // Second .returning() = balance update (returns new balance)
      mockTx.returning.mockResolvedValueOnce([{ id: "receipt-uuid-1" }]);
      mockTx.returning.mockResolvedValueOnce([{ balanceCredits: 98000n }]);

      await service.recordChargeReceipt(params);

      // Verify transaction started
      expect(mockDb.transaction).toHaveBeenCalled();

      // Verify idempotency check ran
      expect(mockTx.query.chargeReceipts.findFirst).toHaveBeenCalled();

      // Verify charge receipt insert with run-centric fields
      expect(mockTx.insert).toHaveBeenCalled();
      expect(mockTx.values).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAccountId: "acc-123",
          virtualKeyId: "vk-123",
          runId: "run-123",
          attempt: 0,
          chargedCredits: 2000n,
          provenance: "response",
        })
      );
    });

    it("returns early without debiting if receipt already exists (idempotent)", async () => {
      // Per GRAPH_EXECUTION.md: Idempotent receipts via (source_system, source_reference)
      // Mock existing receipt found
      mockTx.query.chargeReceipts.findFirst.mockResolvedValue({
        id: "existing-uuid",
        runId: "run-123",
        sourceReference: "run-123/0/call-123",
        billingAccountId: "acc-123",
      });

      await service.recordChargeReceipt(params);

      // Verify idempotency check ran
      expect(mockTx.query.chargeReceipts.findFirst).toHaveBeenCalled();

      // Should NOT proceed with account validation or inserts
      expect(mockTx.query.billingAccounts.findFirst).not.toHaveBeenCalled();
      expect(mockTx.update).not.toHaveBeenCalled();
    });

    it("does NOT throw when balance goes negative (post-call is non-blocking)", async () => {
      // Per ACTIVITY_METRICS.md: recordChargeReceipt must NEVER throw InsufficientCreditsPortError
      // Mock no existing receipt
      mockTx.query.chargeReceipts.findFirst.mockResolvedValue(null);

      // Mock finding account with insufficient balance
      mockTx.query.billingAccounts.findFirst.mockResolvedValue({
        id: "acc-123",
        balanceCredits: 1000n, // Less than 2000n charged
      });

      // Mock finding virtual key (required validation)
      mockTx.query.virtualKeys.findFirst.mockResolvedValue({
        id: "vk-123",
        billingAccountId: "acc-123",
      });

      // First .returning() = charge receipt insert (returns id)
      // Second .returning() = balance update (returns negative balance)
      mockTx.returning.mockResolvedValueOnce([{ id: "receipt-uuid-2" }]);
      mockTx.returning.mockResolvedValueOnce([{ balanceCredits: -1000n }]);

      // Should NOT throw - post-call billing is non-blocking
      await expect(service.recordChargeReceipt(params)).resolves.not.toThrow();
    });

    it("throws error if account not found", async () => {
      // Mock no existing receipt
      mockTx.query.chargeReceipts.findFirst.mockResolvedValue(null);
      mockTx.query.billingAccounts.findFirst.mockResolvedValue(null);

      // Account not found is a hard error (not an insufficient credits case)
      await expect(service.recordChargeReceipt(params)).rejects.toThrow(
        "Billing account not found"
      );
    });
  });
});
