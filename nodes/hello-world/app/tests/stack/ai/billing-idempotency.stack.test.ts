// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/billing-idempotency.stack`
 * Purpose: Verify IDEMPOTENT_CHARGES invariant for run-centric billing.
 * Scope: Executes completion route, then replays with exact persisted values to verify idempotency. Receipts arrive via async LiteLLM callback (CALLBACK_IS_SOLE_WRITER). Does not validate refund logic or partial failure scenarios.
 * Invariants:
 *   - IDEMPOTENT_CHARGES: DB unique on (source_system, source_reference) prevents duplicate charges
 * Side-effects: IO (database writes, LLM calls via mock-openai-api in test mode)
 * Notes: Requires dev stack with DB running (pnpm dev:stack:test). Discovers values from actual execution.
 * Links: GRAPH_EXECUTION.md, billing.ts, schema.billing.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Mock getSessionUser
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import type { UserId } from "@cogni/ids";
import type { SessionUser } from "@cogni/node-shared";
import { createCompletionRequest } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { waitForReceipts } from "@tests/helpers/poll-db";
import { UserDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as completionPOST } from "@/app/api/v1/chat/completions/route";
import {
  billingAccounts,
  chargeReceipts,
  creditLedger,
  users,
  virtualKeys,
} from "@/shared/db/schema";

describe("Billing Idempotency (IDEMPOTENT_CHARGES)", () => {
  it("replay with same (source_system, source_reference) → still 1 row", async () => {
    // Ensure test mode (mock-LLM backend via litellm.test.config.yaml)
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test (mock-LLM backend)");
    }

    const db = getSeedDb();

    // Setup: Create test user, billing account, virtual key
    const mockSessionUser: SessionUser = {
      id: randomUUID(),
      walletAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    const accountService = new UserDrizzleAccountService(
      db,
      mockSessionUser.id as UserId
    );

    await db.insert(users).values({
      id: mockSessionUser.id,
      name: "Idempotency Test User",
      walletAddress: mockSessionUser.walletAddress,
    });

    const billingAccountId = randomUUID();
    const initialBalance = 100_000_000n; // $10 worth
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: mockSessionUser.id,
      balanceCredits: initialBalance,
    });

    const virtualKeyResult = await db
      .insert(virtualKeys)
      .values({
        billingAccountId,
        isDefault: true,
      })
      .returning({ id: virtualKeys.id });
    const virtualKeyId = virtualKeyResult[0]?.id;
    if (!virtualKeyId) throw new Error("Failed to create virtual key");

    // Step 1: Execute a real completion to produce a charge_receipt
    const completionReq = new NextRequest(
      "http://localhost:3000/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          createCompletionRequest({
            messages: [{ role: "user", content: "Idempotency test" }],
          })
        ),
      }
    );

    const completionRes = await completionPOST(completionReq);
    expect(completionRes.status).toBe(200);

    // Step 2: Wait for receipt from async LiteLLM callback (CALLBACK_IS_SOLE_WRITER)
    const receipts = await waitForReceipts(db, billingAccountId);

    expect(receipts.length).toBe(1);
    const originalReceipt = receipts[0];
    if (!originalReceipt) throw new Error("No charge receipt found");

    // Extract exact values from DB - no hardcoding
    const { sourceSystem, sourceReference, runId, attempt, ingressRequestId } =
      originalReceipt;

    // Step 3: Attempt replay with EXACT SAME values via recordChargeReceipt
    // This simulates a retry/replay scenario
    await accountService.recordChargeReceipt({
      billingAccountId,
      virtualKeyId,
      runId,
      attempt,
      ingressRequestId: ingressRequestId ?? undefined,
      chargedCredits: 1000n, // Different amount to prove idempotency ignores it
      responseCostUsd: 0.0001,
      litellmCallId: originalReceipt.litellmCallId,
      provenance: "response",
      chargeReason: "llm_usage",
      sourceSystem,
      sourceReference,
    });

    // Step 4: Assert DB row count is still 1
    const receiptsAfterReplay = await db
      .select()
      .from(chargeReceipts)
      .where(
        and(
          eq(chargeReceipts.sourceSystem, sourceSystem),
          eq(chargeReceipts.sourceReference, sourceReference)
        )
      );

    expect(receiptsAfterReplay.length).toBe(1);

    // Assert the receipt is unchanged (original values, not replay values)
    expect(receiptsAfterReplay[0]?.chargedCredits).toBe(
      originalReceipt.chargedCredits
    );

    // Assert ledger also has only 1 entry for this reference
    const ledgerEntries = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.reference, sourceReference));

    expect(ledgerEntries.length).toBe(1);

    // Assert balance was only debited once
    const account = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.id, billingAccountId));

    expect(account.length).toBe(1);
    // Balance should reflect exactly one debit
    const expectedBalance = initialBalance - originalReceipt.chargedCredits;
    expect(account[0]?.balanceCredits).toBe(expectedBalance);

    // Cleanup
    await db.delete(users).where(eq(users.id, mockSessionUser.id));
  });
});
