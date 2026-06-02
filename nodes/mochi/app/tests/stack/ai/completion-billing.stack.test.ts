// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/completion-billing.stack`
 * Purpose: Verify end-to-end billing flow for AI chat completions in the development stack.
 * Scope: Integration test hitting /api/v1/chat/completions that asserts charge_receipt row creation, credit_ledger debit, and balance_credits update. Does not test production deployment.
 * Invariants: Successful LLM call creates charge_receipt row; credit_ledger records debit; balance is atomically updated.
 * Side-effects: IO (database writes via container, LiteLLM calls)
 * Notes: Requires dev stack running (pnpm dev:stack:db:setup). Uses real DB and LiteLLM. Mocks session.
 * Links: docs/spec/activity-metrics.md
 * @public
 */

import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Mock getSessionUser to simulate authenticated session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { chatCompletionsContract } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { createCompletionRequest } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { waitForReceipts } from "@tests/helpers/poll-db";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST } from "@/app/api/v1/chat/completions/route";
import {
  billingAccounts,
  chargeReceipts,
  creditLedger,
  llmChargeDetails,
  users,
  virtualKeys,
} from "@/shared/db/schema";

describe("Completion Billing Stack Test", () => {
  it("should create charge_receipt row, credit_ledger debit, and update balance on successful completion", async () => {
    // Arrange
    const mockSessionUser: SessionUser = {
      id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e", // Valid UUID v4
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    };

    // Mock session
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    const db = getSeedDb();

    // Seed user
    await db.insert(users).values({
      id: mockSessionUser.id,
      name: "Billing Stack Test User",
      walletAddress: mockSessionUser.walletAddress,
    });

    // Seed billing account with sufficient credits
    // Protocol scale: 10M credits = $1 USD. Seed with $10 worth for safety margin.
    const billingAccountId = "billing-stack-test-account";
    const initialBalance = 100_000_000n; // 100M credits = $10 (protocol scale)
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: mockSessionUser.id,
      balanceCredits: initialBalance,
    });

    // Seed virtual key (scope/FK handle only)
    await db.insert(virtualKeys).values({
      billingAccountId,
      isDefault: true,
    });

    const req = new NextRequest(
      "http://localhost:3000/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          createCompletionRequest({
            messages: [{ role: "user", content: "Say 'hello' in one word." }],
          })
        ),
      }
    );

    // Receipts arrive asynchronously via LiteLLM callback (CALLBACK_IS_SOLE_WRITER)
    const receiptsBefore = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.billingAccountId, billingAccountId));
    const initialReceiptCount = receiptsBefore.length;

    // Act
    const response = await POST(req);

    // Assert - Response successful
    expect(response.status).toBe(200);
    const json = await response.json();

    // Assert - Response matches OpenAI ChatCompletion contract
    const validated = chatCompletionsContract.output.parse(json);
    expect(validated.object).toBe("chat.completion");
    expect(validated.choices).toHaveLength(1);
    expect(validated.choices[0]?.message.role).toBe("assistant");
    expect(validated.choices[0]?.message.content).toBeTruthy();
    expect(validated.usage.total_tokens).toBeGreaterThan(0);

    // Assert - charge_receipt row created (per ACTIVITY_METRICS.md)
    // NOTE: No model/tokens/billingStatus - LiteLLM is canonical for telemetry
    const receiptRows = await waitForReceipts(db, billingAccountId, {
      minCount: initialReceiptCount + 1,
      timeoutMs: 30_000,
    });
    expect(receiptRows.length).toBeGreaterThan(initialReceiptCount);
    const [receipt] = receiptRows.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (!receipt) throw new Error("No charge receipt row");

    // Get the virtual key to verify
    const vkRows = await db
      .select()
      .from(virtualKeys)
      .where(eq(virtualKeys.billingAccountId, billingAccountId));
    expect(vkRows.length).toBeGreaterThan(0);
    const [vk] = vkRows;
    if (!vk) throw new Error("No virtual key");
    const virtualKeyId = vk.id;

    // Minimal charge_receipt fields per ACTIVITY_METRICS.md
    expect(receipt.virtualKeyId).toBe(virtualKeyId);
    expect(receipt.runId).toBeTruthy();
    expect(receipt.provenance).toBe("stream"); // Per UNIFIED_GRAPH_EXECUTOR: all execution flows through streaming

    // Per RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST: paid model must have cost > 0
    expect(receipt.responseCostUsd).not.toBeNull();
    expect(Number(receipt.responseCostUsd)).toBeGreaterThan(0);

    // Exactly 1 receipt per litellm_call_id (no duplicates)
    const allReceipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, receipt.runId));
    for (const r of allReceipts) {
      if (!r.litellmCallId) continue;
      const byCallId = allReceipts.filter(
        (x) => x.litellmCallId === r.litellmCallId
      );
      expect(byCallId).toHaveLength(1);
    }
    // No $0 receipts for paid models
    const zeroReceipts = allReceipts.filter(
      (r) => r.responseCostUsd !== null && Number(r.responseCostUsd) === 0
    );
    expect(zeroReceipts).toHaveLength(0);

    // Assert - Linked llm_charge_details row with model, graphId, tokens
    const details = await db
      .select()
      .from(llmChargeDetails)
      .where(eq(llmChargeDetails.chargeReceiptId, receipt.id));

    expect(details).toHaveLength(1);
    const detail = details[0];
    if (!detail) throw new Error("No llm_charge_details row");
    expect(detail.model).toBeTruthy();
    expect(detail.graphId).toBeTruthy();
    expect(typeof detail.tokensIn).toBe("number");
    expect(typeof detail.tokensOut).toBe("number");

    // Assert - credit_ledger debit created
    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.billingAccountId, billingAccountId),
          eq(creditLedger.reason, "charge_receipt")
        )
      );

    expect(ledgerRows.length).toBeGreaterThan(0);
    const [ledgerRow] = ledgerRows;
    if (!ledgerRow) throw new Error("No ledger row");
    expect(ledgerRow.virtualKeyId).toBe(virtualKeyId);
    expect(ledgerRow.amount).toBeLessThanOrEqual(0n); // Debit is negative or zero (free models)
    // Charge receipt's chargedCredits should match ledger debit magnitude
    expect(BigInt(Math.abs(Number(ledgerRow.amount)))).toBe(
      receipt.chargedCredits
    );

    // Assert - balance_credits updated
    const updatedAccount = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.id, billingAccountId));

    expect(updatedAccount.length).toBe(1);
    const [account] = updatedAccount;
    if (!account) throw new Error("No account");
    const finalBalance = account.balanceCredits;
    expect(finalBalance).toBe(initialBalance + ledgerRow.amount); // initial - cost
    expect(finalBalance).toBeLessThanOrEqual(initialBalance); // Balance decreased or unchanged (free model)
    expect(finalBalance).toBeGreaterThanOrEqual(0n); // Non-negative

    // Assert - balanceAfter matches final balance
    expect(ledgerRow.balanceAfter).toBe(finalBalance);
  }, 45_000);

  it("should fail with insufficient credits (preflight gating) and not create records", async () => {
    // Arrange
    const mockSessionUser: SessionUser = {
      id: "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f", // Valid UUID v4
      walletAddress: "0x2222222222222222222222222222222222222222",
    };

    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    const db = getSeedDb();

    // Seed user
    await db.insert(users).values({
      id: mockSessionUser.id,
      name: "Insufficient Credits Test User",
      walletAddress: mockSessionUser.walletAddress,
    });

    // Seed billing account with ZERO credits
    const billingAccountId = "billing-stack-test-insufficient";
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: mockSessionUser.id,
      balanceCredits: 0n, // No credits
    });

    // Seed virtual key (scope/FK handle only)
    await db.insert(virtualKeys).values({
      billingAccountId,
      isDefault: true,
    });

    const req = new NextRequest(
      "http://localhost:3000/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(createCompletionRequest()),
      }
    );

    // Act
    const response = await POST(req);

    // Assert - Request failed (OpenAI: 429 insufficient_quota)
    expect(response.status).toBe(429);

    // Assert - NO charge_receipt row created (transaction rolled back)
    const usageRows = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.billingAccountId, billingAccountId));

    expect(usageRows.length).toBe(0);

    // Assert - NO credit_ledger entry (transaction rolled back)
    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.billingAccountId, billingAccountId));

    expect(ledgerRows.length).toBe(0);

    // Assert - Balance unchanged
    const account = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.id, billingAccountId));

    expect(account.length).toBe(1);
    const [billingAccount] = account;
    if (!billingAccount) throw new Error("No billing account");
    expect(billingAccount.balanceCredits).toBe(0n); // Still zero
  });
});
