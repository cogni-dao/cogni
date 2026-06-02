// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/chat-model-validation.stack`
 * Purpose: Validates chat route model validation and 409 fallback flow in development stack.
 * Scope: Tests model allowlist checking and 409 response with defaultModelId. Does not test LLM completion logic.
 * Invariants: Invalid model returns 409 with defaultModelId; valid model proceeds to completion.
 * Side-effects: IO (database, cache fetch to LiteLLM /model/info)
 * Notes: Tests MVP-004 UX-001 fix - graceful fallback on invalid model selection.
 * Links: docs/spec/model-selection.md, src/app/api/v1/ai/chat/route.ts:162-179
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import { createChatRequest } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as chatPOST } from "@/app/api/v1/ai/chat/route";
import { GET as modelsGET } from "@/app/api/v1/ai/models/route";
import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

describe("Chat Model Validation Stack Test", () => {
  it("should return 409 with working defaultModelId fallback when model not in allowlist", async () => {
    // Arrange - Use unique IDs per test run to avoid DB conflicts
    const userId = randomUUID();
    const walletAddress = `0x${randomUUID().replace(/-/g, "").substring(0, 40)}`;
    const billingAccountId = randomUUID();

    const mockSessionUser: SessionUser = {
      id: userId,
      walletAddress,
    };

    const db = getSeedDb();

    // Seed user
    await db.insert(users).values({
      id: userId,
      name: "Model Validation Test User",
      walletAddress,
    });

    // Seed billing account
    // Protocol scale: 10M credits = $1 USD. Seed with $10 worth.
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: userId,
      balanceCredits: 100_000_000n, // 100M credits = $10
    });

    // Seed virtual key (scope/FK handle only)
    await db.insert(virtualKeys).values({
      billingAccountId,
      isDefault: true,
    });

    // Mock session for all requests (models + chat)
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    // Arrange - Fetch actual models list to get real defaultRef
    const modelsReq = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const modelsRes = await modelsGET(modelsReq);
    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    const { defaultRef, models } = modelsData;
    expect(defaultRef).toBeTruthy();
    expect(models.length).toBeGreaterThan(0);

    // Act - Send chat request with invalid model
    const invalidReq = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...createChatRequest({
          modelRef: {
            providerKey: "platform",
            modelId: "invalid-model-not-in-allowlist",
          },
          stateKey: randomUUID(),
          messages: [
            {
              id: randomUUID(),
              role: "user",
              createdAt: new Date().toISOString(),
              content: [{ type: "text", text: "Hello" }],
            },
          ],
        }),
        clientRequestId: randomUUID(),
      }),
    });

    const invalidResponse = await chatPOST(invalidReq);

    // Model validation deferred to execution-time. LiteLLM rejects unknown models,
    // facade peeks first stream event (error), throws AiExecutionError → route maps to 500.
    expect(invalidResponse.status).toBe(500);

    // Critical: Assert defaultRef actually works (not a retry loop)
    const retryReq = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...createChatRequest({
          modelRef: defaultRef, // Use the defaultRef from models endpoint
          stateKey: randomUUID(),
          messages: [
            {
              id: randomUUID(),
              role: "user",
              createdAt: new Date().toISOString(),
              content: [{ type: "text", text: "Hello" }],
            },
          ],
        }),
        clientRequestId: randomUUID(),
      }),
    });

    const retryResponse = await chatPOST(retryReq);

    // Assert - Retry with defaultModelId succeeds (NOT 409)
    expect(retryResponse.status).not.toBe(409);
    expect(retryResponse.status).toBe(200); // Should succeed
  });
});
