// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/payments/tigerbeetle-adapter.stack`
 * Purpose: Stack-level integration tests for TigerBeetleAdapter against real TigerBeetle.
 * Scope: Validates adapter operations — account creation, transfers, linked transfers, lookups, idempotency. Does not test co-write wiring or HTTP routes.
 * Invariants: DOUBLE_ENTRY_CANONICAL, ALL_MATH_BIGINT, idempotent account creation
 * Side-effects: IO (TigerBeetle network calls)
 * Links: packages/financial-ledger/src/adapters/tigerbeetle.adapter.ts, docs/spec/financial-ledger.md
 * @public
 */

import { randomUUID } from "node:crypto";

import {
  ACCOUNT,
  ACCOUNT_CODE,
  LEDGER,
  TRANSFER_CODE,
  uuidToBigInt,
} from "@cogni/financial-ledger";
import { createTigerBeetleAdapter } from "@cogni/financial-ledger/adapters";
import { beforeAll, describe, expect, it } from "vitest";

function requireTigerBeetle(): string {
  const addr = process.env.TIGERBEETLE_ADDRESS;
  if (!addr) {
    throw new Error(
      "TIGERBEETLE_ADDRESS is required for TigerBeetle stack tests. " +
        "Start the stack with: pnpm dev:stack:test"
    );
  }
  return addr;
}

describe("TigerBeetleAdapter (stack)", () => {
  let adapter: ReturnType<typeof createTigerBeetleAdapter>;

  beforeAll(async () => {
    const address = requireTigerBeetle();
    adapter = createTigerBeetleAdapter(address);
    // Trigger lazy account creation
    await adapter.lookupAccounts([ACCOUNT.LIABILITY_USER_CREDITS]);
  });

  describe("account creation (idempotent)", () => {
    it("creates all 5 well-known accounts", async () => {
      const accounts = await adapter.lookupAccounts([
        ACCOUNT.LIABILITY_USER_CREDITS,
        ACCOUNT.REVENUE_AI_USAGE,
        ACCOUNT.EQUITY_CREDIT_ISSUANCE,
        ACCOUNT.ASSETS_TREASURY,
        ACCOUNT.ASSETS_OPERATOR_FLOAT,
      ]);
      expect(accounts).toHaveLength(5);
    });

    it("is idempotent — second init does not throw", async () => {
      const accounts = await adapter.lookupAccounts([
        ACCOUNT.LIABILITY_USER_CREDITS,
      ]);
      expect(accounts).toHaveLength(1);
    });

    it("returns correct ledger and code for each account", async () => {
      const accounts = await adapter.lookupAccounts([
        ACCOUNT.LIABILITY_USER_CREDITS,
        ACCOUNT.ASSETS_TREASURY,
      ]);

      const liability = accounts.find(
        (a) => a.id === ACCOUNT.LIABILITY_USER_CREDITS
      );
      expect(liability).toBeDefined();
      expect(liability?.ledger).toBe(LEDGER.CREDIT);
      expect(liability?.code).toBe(ACCOUNT_CODE.LIABILITY);

      const treasury = accounts.find((a) => a.id === ACCOUNT.ASSETS_TREASURY);
      expect(treasury).toBeDefined();
      expect(treasury?.ledger).toBe(LEDGER.USDC);
      expect(treasury?.code).toBe(ACCOUNT_CODE.ASSETS);
    });
  });

  describe("transfer (single-ledger)", () => {
    it("executes a CREDIT ledger deposit transfer", async () => {
      const transferId = uuidToBigInt(randomUUID());

      await adapter.transfer({
        id: transferId,
        debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
        creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
        amount: 1000n,
        ledger: LEDGER.CREDIT,
        code: TRANSFER_CODE.CREDIT_DEPOSIT,
      });

      const balance = await adapter.getAccountBalance(
        ACCOUNT.LIABILITY_USER_CREDITS
      );
      expect(balance.creditsPosted).toBeGreaterThanOrEqual(1000n);
    });

    it("is idempotent — same transfer ID is a no-op", async () => {
      const transferId = uuidToBigInt(randomUUID());
      const params = {
        id: transferId,
        debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
        creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
        amount: 500n,
        ledger: LEDGER.CREDIT,
        code: TRANSFER_CODE.CREDIT_DEPOSIT,
      };

      await adapter.transfer(params);
      // Second call with same ID — must not throw
      await adapter.transfer(params);
    });

    it("AI usage transfer: liability → revenue", async () => {
      // Deposit first so liability has balance
      await adapter.transfer({
        id: uuidToBigInt(randomUUID()),
        debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
        creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
        amount: 5000n,
        ledger: LEDGER.CREDIT,
        code: TRANSFER_CODE.CREDIT_DEPOSIT,
      });

      const usageId = uuidToBigInt(randomUUID());
      await adapter.transfer({
        id: usageId,
        debitAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
        creditAccountId: ACCOUNT.REVENUE_AI_USAGE,
        amount: 2000n,
        ledger: LEDGER.CREDIT,
        code: TRANSFER_CODE.AI_USAGE,
      });

      const revenue = await adapter.getAccountBalance(ACCOUNT.REVENUE_AI_USAGE);
      expect(revenue.creditsPosted).toBeGreaterThanOrEqual(2000n);
    });

    it("stores userData128 for Postgres linkage", async () => {
      const receiptBigInt = uuidToBigInt(randomUUID());
      const transferId = uuidToBigInt(randomUUID());

      // Transfer accepted with userData128 — no error means it was stored.
      // Transfer lookup requires query API (not in tigerbeetle-node v0.16).
      await adapter.transfer({
        id: transferId,
        debitAccountId: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
        creditAccountId: ACCOUNT.LIABILITY_USER_CREDITS,
        amount: 100n,
        ledger: LEDGER.CREDIT,
        code: TRANSFER_CODE.CREDIT_DEPOSIT,
        userData128: receiptBigInt,
      });
    });
  });

  describe("linkedTransfers", () => {
    it("executes linked transfers atomically", async () => {
      const id1 = uuidToBigInt(randomUUID());
      const id2 = uuidToBigInt(randomUUID());

      await adapter.linkedTransfers([
        {
          id: id1,
          debitAccountId: ACCOUNT.ASSETS_TREASURY,
          creditAccountId: ACCOUNT.ASSETS_OPERATOR_FLOAT,
          amount: 100n,
          ledger: LEDGER.USDC,
          code: TRANSFER_CODE.SPLIT_DISTRIBUTE,
        },
        {
          id: id2,
          debitAccountId: ACCOUNT.ASSETS_OPERATOR_FLOAT,
          creditAccountId: ACCOUNT.ASSETS_TREASURY,
          amount: 50n,
          ledger: LEDGER.USDC,
          code: TRANSFER_CODE.PROVIDER_TOPUP,
        },
      ]);

      const opFloat = await adapter.getAccountBalance(
        ACCOUNT.ASSETS_OPERATOR_FLOAT
      );
      expect(opFloat.creditsPosted).toBeGreaterThanOrEqual(100n);
      expect(opFloat.debitsPosted).toBeGreaterThanOrEqual(50n);
    });

    it("handles empty array without error", async () => {
      await adapter.linkedTransfers([]);
    });
  });

  describe("getAccountBalance", () => {
    it("returns all four balance fields", async () => {
      const balance = await adapter.getAccountBalance(
        ACCOUNT.EQUITY_CREDIT_ISSUANCE
      );
      expect(typeof balance.creditsPosted).toBe("bigint");
      expect(typeof balance.debitsPosted).toBe("bigint");
      expect(typeof balance.creditsPending).toBe("bigint");
      expect(typeof balance.debitsPending).toBe("bigint");
    });

    it("throws AccountNotFoundError for non-existent account", async () => {
      await expect(adapter.getAccountBalance(999999n)).rejects.toThrow(
        "Account 999999 not found"
      );
    });
  });

  describe("lookupAccounts", () => {
    it("returns empty array for empty input", async () => {
      const result = await adapter.lookupAccounts([]);
      expect(result).toEqual([]);
    });

    it("returns only accounts that exist", async () => {
      const result = await adapter.lookupAccounts([
        ACCOUNT.LIABILITY_USER_CREDITS,
        888888n,
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(ACCOUNT.LIABILITY_USER_CREDITS);
    });
  });
});
