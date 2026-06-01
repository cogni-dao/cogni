// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/litellm-call-id-mapping`
 * Purpose: Verify x-litellm-call-id response header equals spend_logs.request_id field.
 * Scope: Stack test ensuring LiteLLM's response header and reconciliation API use the same ID. Does NOT test billing logic.
 * Invariants:
 *   - USAGE_UNIT_IS_LITELLM_CALL_ID: usageUnitId captured from x-litellm-call-id equals spend_logs.request_id
 *   - Field name is stable across LiteLLM versions (test breaks if LiteLLM changes the field)
 * Side-effects: IO (LLM call, database read, HTTP request to LiteLLM API)
 * Notes: Requires running stack (dev:stack:test). Uses real LiteLLM via FakeLlmAdapter in test mode.
 * Links: docs/spec/external-executor-billing.md (invariant #2), packages/ai-core/src/usage/usage.ts (usageUnitId comment)
 * @public
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import type { SessionUser } from "@cogni/node-shared";
import { createCompletionRequest, TEST_MODEL_ID } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as completionPOST } from "@/app/api/v1/chat/completions/route";
import {
  billingAccounts,
  chargeReceipts,
  users,
  virtualKeys,
} from "@/shared/db/schema";
import { serverEnv } from "@/shared/env";

describe("LiteLLM Call ID → Spend Log Mapping (Contract Test)", () => {
  // TODO: Enable when system test infra lands (see docs/spec/system-test-architecture.md)
  // Requires real LiteLLM (not FakeLlmAdapter) to verify the invariant:
  //   x-litellm-call-id response header === spend_logs.request_id field
  // Manually verified 2026-02-07: charge_receipts.litellm_call_id matched
  //   GET /spend/logs?request_id= on dev stack (nemotron-nano-30b, $0 free model).
  it.skip("verifies x-litellm-call-id header equals spend_logs.request_id field", async () => {
    // Skip if not in appropriate test environment
    const env = serverEnv();
    if (!env.LITELLM_BASE_URL || !env.LITELLM_MASTER_KEY) {
      console.log(
        "Skipping LiteLLM contract test - requires LITELLM_BASE_URL and LITELLM_MASTER_KEY"
      );
      return;
    }

    // 1. Setup authenticated user with credits
    const mockSessionUser: SessionUser = {
      id: randomUUID(),
      walletAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, mockSessionUser.id));

    await db.insert(users).values({
      id: mockSessionUser.id,
      name: "LiteLLM Contract Test User",
      walletAddress: mockSessionUser.walletAddress,
    });

    const billingAccountId = randomUUID();
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: mockSessionUser.id,
      balanceCredits: 100_000_000n, // $10
    });

    await db.insert(virtualKeys).values({
      id: randomUUID(),
      billingAccountId,
      isDefault: true,
    });

    // 2. Make completion call (uses real LiteLLM, not fake)
    const completionReq = new NextRequest(
      "http://localhost:3000/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          createCompletionRequest({
            messages: [
              { role: "user", content: "Say 'contract test verified'" },
            ],
            model: TEST_MODEL_ID,
          })
        ),
      }
    );

    const completionRes = await completionPOST(completionReq);
    expect(completionRes.status).toBe(200);
    const completionJson = await completionRes.json();
    // Extract requestId from OpenAI completion ID format: chatcmpl-{reqId}
    const requestId = (completionJson.id as string).replace("chatcmpl-", "");
    expect(requestId).toBeDefined();

    // 3. Query charge_receipts to get usageUnitId (this is the x-litellm-call-id we captured)
    const receipt = await db.query.chargeReceipts.findFirst({
      where: eq(chargeReceipts.runId, requestId),
    });

    expect(receipt).toBeDefined();
    expect(receipt?.sourceReference).toBeDefined();

    // Extract usageUnitId from source_reference (format: runId/attempt/usageUnitId)
    const sourceRefParts = receipt?.sourceReference?.split("/");
    expect(sourceRefParts).toHaveLength(3);
    const capturedCallId = sourceRefParts?.[2];
    expect(capturedCallId).toBeDefined();
    expect(capturedCallId?.length).toBeGreaterThan(0);

    // 4. Query LiteLLM /spend/logs API
    const spendLogsUrl = new URL("/spend/logs", env.LITELLM_BASE_URL);
    spendLogsUrl.searchParams.set("end_user", billingAccountId);

    const spendLogsRes = await fetch(spendLogsUrl.toString(), {
      headers: {
        Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
      },
    });

    expect(spendLogsRes.ok).toBe(true);
    const spendLogs = await spendLogsRes.json();
    expect(Array.isArray(spendLogs)).toBe(true);
    expect(spendLogs.length).toBeGreaterThan(0);

    // 5. Find the matching spend log entry by filtering for our request
    // (LiteLLM stores metadata.run_id in spend logs)
    const matchingLog = spendLogs.find((log: { request_id: string }) => {
      return log.request_id === capturedCallId;
    });

    // 6. CRITICAL ASSERTION: verify the field mapping
    expect(matchingLog).toBeDefined();
    expect(matchingLog?.request_id).toBe(capturedCallId);

    // Cleanup
    await db.delete(users).where(eq(users.id, mockSessionUser.id));
  });
});
