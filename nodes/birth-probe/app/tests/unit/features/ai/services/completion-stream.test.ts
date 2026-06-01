// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/completion-stream.test`
 * Purpose: Unit tests for the streaming execution path in the completion feature service.
 * Scope: Verifies orchestration of streaming and event propagation. Does not test real LLM integration.
 * Invariants: Per GRAPH_EXECUTION.md, billing occurs via RunEventRelay (tested in stack tests, not here).
 * Side-effects: none
 * Links: Tests executeStream in completion.ts
 * @internal
 */

import {
  createMockAccountServiceWithDefaults,
  createUserMessage,
  FakeAiTelemetryAdapter,
  FakeClock,
  FakeLlmService,
  TEST_MODEL_ID,
} from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";

import { executeStream } from "@/features/ai/services/completion";
import type { LlmCaller } from "@/ports";
import type { RequestContext } from "@/shared/observability";
import { makeNoopLogger } from "@/shared/observability";

// Helper to create fake telemetry for tests
const createFakeAiTelemetry = () => new FakeAiTelemetryAdapter();

// Mock serverEnv
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    USER_PRICE_MARKUP_FACTOR: 1.5,
  }),
}));

describe("features/ai/services/completion (stream)", () => {
  const createTestCaller = (): LlmCaller => ({
    billingAccountId: "billing-test-user",
    virtualKeyId: "virtual-key-123",
    requestId: "req-test",
    traceId: "trace-test",
  });

  it("should orchestrate streaming flow and bill on completion", async () => {
    // Arrange
    const messages = [createUserMessage("Hello")];
    const llmService = new FakeLlmService({
      responseContent: "Streamed response",
    });
    const clock = new FakeClock("2025-01-01T12:00:00.000Z");
    const caller = createTestCaller();
    const testCtx: RequestContext = {
      log: makeNoopLogger(),
      reqId: "test-req-123",
      traceId: "00000000000000000000000000000000",
      routeId: "test.route",
      clock,
    };
    const accountService = createMockAccountServiceWithDefaults();

    // Act
    const { stream, final } = await executeStream({
      messages,
      model: TEST_MODEL_ID,
      llmService,
      accountService,
      clock,
      caller,
      ctx: testCtx,
      aiTelemetry: createFakeAiTelemetry(),
      langfuse: undefined,
    });

    // Consume stream
    const chunks: string[] = [];
    for await (const event of stream) {
      if (event.type === "text_delta") {
        chunks.push(event.delta);
      }
    }

    const result = await final;

    // Assert - stream content and final result shape
    expect(chunks).toEqual(["Streamed response"]);
    expect(result).toMatchObject({
      ok: true,
      requestId: expect.any(String),
      usage: { promptTokens: 10, completionTokens: 10 },
      finishReason: "stop",
    });

    // Note: Billing now occurs via RunEventRelay → commitUsageFact() (per GRAPH_EXECUTION.md)
    // See tests/stack/ai/billing-*.stack.test.ts for billing flow tests
  });
});
