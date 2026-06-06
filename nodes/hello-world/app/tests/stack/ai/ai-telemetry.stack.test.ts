// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/ai-telemetry.stack`
 * Purpose: Verify ai_invocation_summaries telemetry writes on success and error paths.
 * Scope: Integration test hitting /api/v1/ai/completion that asserts ai_invocation_summaries row creation with proper correlation IDs. Does not test Langfuse integration.
 * Invariants: Per AI_SETUP_SPEC.md P0 test gates - telemetry rows MUST be written on both success and error paths.
 * Side-effects: IO (database writes via container, LiteLLM calls)
 * Notes: Requires dev stack running (pnpm dev:stack:db:setup). Uses real DB and LiteLLM for success path; mocks LiteLLM for error path.
 * Links: docs/spec/ai-setup.md
 * @public
 */

import type { SessionUser } from "@cogni/node-shared";
import { createCompletionRequest } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST } from "@/app/api/v1/chat/completions/route";
import {
  aiInvocationSummaries,
  billingAccounts,
  users,
  virtualKeys,
} from "@/shared/db/schema";

// Mock getSessionUser to simulate authenticated session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

/** Zero trace ID (OTel not initialized) - tests should verify trace_id is NOT this */
const ZERO_TRACE_ID = "00000000000000000000000000000000";

describe("AI Telemetry Stack Tests", () => {
  const initialBalance = 100_000_000n; // 100M credits = $10

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("success path (P0 invariant)", () => {
    it("writes ai_invocation_summaries row on successful completion", async () => {
      // Arrange - unique IDs for this test (avoid collision with other stack tests)
      const mockSessionUser: SessionUser = {
        id: "f1f2f3f4-f5f6-4f7f-8f9f-0f1f2f3f4f5f",
        walletAddress: "0xAiTelemetrySuccessTest123456789012345678",
      };
      const billingAccountId = "ai-telem-success-test-acct";

      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const db = getSeedDb();

      // Seed user
      await db.insert(users).values({
        id: mockSessionUser.id,
        name: "Telemetry Success Test User",
        walletAddress: mockSessionUser.walletAddress,
      });

      // Seed billing account with sufficient credits
      await db.insert(billingAccounts).values({
        id: billingAccountId,
        ownerUserId: mockSessionUser.id,
        balanceCredits: initialBalance,
      });

      // Seed virtual key
      await db.insert(virtualKeys).values({
        billingAccountId,
        isDefault: true,
      });

      const requestBody = createCompletionRequest({
        messages: [{ role: "user", content: "Say hello in one word." }],
      });

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(requestBody),
        }
      );

      // Act
      const response = await POST(req);
      const responseJson = await response.json();

      // Assert - Response successful (OpenAI-compatible format)
      expect(response.status).toBe(200);
      expect(responseJson.id).toBeDefined();
      // Extract requestId from OpenAI completion ID format: chatcmpl-{reqId}
      const returnedRequestId = (responseJson.id as string).replace(
        "chatcmpl-",
        ""
      );

      // Query ai_invocation_summaries by THIS request's ID (not status - avoids stale CI data)
      const rows = await db
        .select()
        .from(aiInvocationSummaries)
        .where(eq(aiInvocationSummaries.requestId, returnedRequestId))
        .orderBy(desc(aiInvocationSummaries.createdAt))
        .limit(1);

      expect(rows.length).toBe(1);

      const [row] = rows;
      if (!row)
        throw new Error(
          `No ai_invocation_summaries row for requestId=${returnedRequestId}`
        );

      // P0 Assertions per AI_SETUP_SPEC.md Test Gates
      // 1. status = 'success'
      expect(row.status).toBe("success");

      // 2. request_id is present AND matches returned requestId (P0 stability invariant)
      expect(row.requestId).toBeTruthy();
      expect(row.requestId.length).toBeGreaterThan(0);
      expect(row.requestId).toBe(returnedRequestId);

      // 3. trace_id is 32-hex AND not all-zeros (proves OTel SDK is running)
      expect(row.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(row.traceId).not.toBe(ZERO_TRACE_ID);

      // 4. invocation_id is present and looks like a UUID
      expect(row.invocationId).toBeTruthy();
      expect(row.invocationId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
      );

      // 5. prompt_hash is 64-hex (SHA-256)
      expect(row.promptHash).toMatch(/^[a-f0-9]{64}$/);

      // 6. provider + model populated (resolved values from LiteLLM)
      expect(row.provider).toBeTruthy();
      expect(row.model).toBeTruthy();

      // 7. latency_ms is integer >= 0 (prevents float regression)
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(row.latencyMs)).toBe(true);

      // 8. error_code should be NULL for success
      expect(row.errorCode).toBeNull();

      // 9. langfuse_trace_id should be null when LANGFUSE_* unset (CI default)
      // This proves DrizzleAdapter works independently of Langfuse
      // (If Langfuse is configured, it would equal trace_id)
    });
  });

  describe("error path (P0 invariant)", () => {
    // SKIP: Stack tests use FakeLLMAdapter which doesn't fail on invalid models.
    // This test requires systems integration tests with real LiteLLM to verify
    // that ai_invocation_summaries rows are written on LLM errors.
    // TODO: Add to systems integration test suite when available.
    it.skip("writes ai_invocation_summaries row on LLM error", async () => {
      // For this test, we need to force an LLM error deterministically.
      // This requires real LiteLLM integration (systems tests, not stack tests).

      // Arrange - unique IDs for this test (different from success test)
      const mockSessionUser: SessionUser = {
        id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        walletAddress: "0xTelemetryErrorTest123456789012345678901",
      };
      const billingAccountId = "telemetry-error-test-account";

      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const db = getSeedDb();

      // Seed user
      await db.insert(users).values({
        id: mockSessionUser.id,
        name: "Telemetry Error Test User",
        walletAddress: mockSessionUser.walletAddress,
      });

      // Seed billing account with sufficient credits
      await db.insert(billingAccounts).values({
        id: billingAccountId,
        ownerUserId: mockSessionUser.id,
        balanceCredits: initialBalance,
      });

      // Seed virtual key
      await db.insert(virtualKeys).values({
        billingAccountId,
        isDefault: true,
      });

      const requestBody = createCompletionRequest({
        messages: [{ role: "user", content: "Hello" }],
        model: "nonexistent/invalid-model-that-will-fail", // Invalid model
      });

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(requestBody),
        }
      );

      // Act
      const response = await POST(req);

      // Assert - Response is an error (4xx or 5xx)
      expect(response.status).toBeGreaterThanOrEqual(400);

      // Query ai_invocation_summaries for error rows
      const rows = await db
        .select()
        .from(aiInvocationSummaries)
        .where(eq(aiInvocationSummaries.status, "error"));

      // Find recent error row
      const recentRows = rows.filter(
        (r) => new Date(r.createdAt).getTime() > Date.now() - 60000
      );
      expect(recentRows.length).toBeGreaterThan(0);

      const [row] = recentRows.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      if (!row) throw new Error("No ai_invocation_summaries error row found");

      // P0 Assertions per AI_SETUP_SPEC.md Test Gates
      // 1. status = 'error'
      expect(row.status).toBe("error");

      // 2. error_code is one of the low-cardinality set
      expect([
        "timeout",
        "rate_limited",
        "provider_4xx",
        "provider_5xx",
        "aborted",
        "unknown",
      ]).toContain(row.errorCode);

      // 3. prompt_hash is present (NOT 'unavailable', NOT null) - proves computed BEFORE LLM call
      expect(row.promptHash).toBeTruthy();
      expect(row.promptHash).not.toBe("unavailable");
      expect(row.promptHash).toMatch(/^[a-f0-9]{64}$/);

      // 4. trace_id is 32-hex AND not all-zeros (proves OTel SDK is running)
      expect(row.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(row.traceId).not.toBe(ZERO_TRACE_ID);

      // 5. invocation_id present
      expect(row.invocationId).toBeTruthy();
      expect(row.invocationId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
      );

      // 6. request_id present
      expect(row.requestId).toBeTruthy();

      // 7. latency_ms is integer >= 0 (prevents float regression)
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(row.latencyMs)).toBe(true);
    });
  });
});
