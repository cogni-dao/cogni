// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/completion`
 * Purpose: Verifies AI completion orchestration with message processing and LLM coordination.
 * Scope: Feature service testing with mocks. Does NOT test real LLM or HTTP integration.
 * Invariants: Message filtering; history trimming; error propagation; timestamp injection.
 * Side-effects: none
 * Notes: Uses fake services for deterministic testing; covers validation failures.
 * Links: completion execute function, LlmService port
 * @public
 */

import { ChatValidationError, MAX_MESSAGE_CHARS } from "@cogni/node-core";
import {
  createConversation,
  createLongMessage,
  createMixedRoleConversation,
  createMockAccountServiceWithDefaults,
  createUserMessage,
  FakeAiTelemetryAdapter,
  FakeClock,
  FakeLlmService,
  TEST_MODEL_ID,
} from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";
import { execute } from "@/features/ai/services/completion";
import type { LlmCaller } from "@/ports";
import { InsufficientCreditsPortError } from "@/ports";
import type { RequestContext } from "@/shared/observability";
import { makeNoopLogger } from "@/shared/observability";

// Helper to create fake telemetry for tests
const createFakeAiTelemetry = () => new FakeAiTelemetryAdapter();

// Mock model catalog
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelFree: vi.fn().mockImplementation(async (modelId: string) => {
    return modelId === "free-model";
  }),
  getModelClass: vi.fn().mockResolvedValue("standard"),
}));

// Mock serverEnv
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    USER_PRICE_MARKUP_FACTOR: 1.5,
  }),
}));

describe("features/ai/services/completion", () => {
  // Helper to create test caller
  const createTestCaller = (): LlmCaller => ({
    billingAccountId: "billing-test-user",
    virtualKeyId: "virtual-key-123",
    requestId: "req-test",
    traceId: "trace-test",
  });

  // Skipped: execute() is deprecated stub per GRAPH_OWNS_MESSAGES refactor
  describe.skip("execute", () => {
    it("should orchestrate completion flow for valid messages", async () => {
      // Arrange
      const messages = createConversation("Hello", "Hi");
      const llmService = new FakeLlmService({ responseContent: "AI response" });
      const clock = new FakeClock("2025-01-01T12:00:00.000Z");
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      const result = await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert
      expect(result.message).toEqual({
        role: "assistant",
        content: "AI response",
        timestamp: "2025-01-01T12:00:00.000Z",
      });
      // P0 invariant: returned requestId MUST equal ctx.reqId (stable per request entry)
      expect(result.requestId).toBe(testCtx.reqId);
      expect(llmService.wasCalled()).toBe(true);

      // Critical invariant: exactly one system message in LLM payload
      const payload = llmService.getLastCall();
      const systemMessages = payload?.messages.filter(
        (m) => m.role === "system"
      );
      expect(systemMessages).toHaveLength(1);
      expect(payload?.messages[0]?.role).toBe("system");
      expect(payload?.messages[0]?.content).toContain("You are Cogni");

      // Note: Billing now occurs via RunEventRelay → commitUsageFact() (per GRAPH_EXECUTION.md)
    });

    it("should strip malicious client system messages and inject baseline only", async () => {
      // Arrange
      const messages = createMixedRoleConversation(); // includes system messages
      const llmService = new FakeLlmService();
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert - Critical invariant: exactly one system message with baseline content
      const payload = llmService.getLastCall();
      const systemMessages = payload?.messages.filter(
        (m) => m.role === "system"
      );
      expect(systemMessages).toHaveLength(1);
      expect(payload?.messages[0]?.role).toBe("system");
      expect(payload?.messages[0]?.content).toContain("You are Cogni");
      // Verify no client system messages survived
      expect(payload?.messages.slice(1).every((m) => m.role !== "system")).toBe(
        true
      );
    });

    it("should throw ChatValidationError for messages exceeding length limit", async () => {
      // Arrange
      const messages = [createLongMessage(MAX_MESSAGE_CHARS + 1)];
      const llmService = new FakeLlmService();
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act & Assert
      const accountService = createMockAccountServiceWithDefaults();
      await expect(
        execute(
          messages,
          TEST_MODEL_ID,
          llmService,
          accountService,
          clock,
          caller,
          testCtx,
          createFakeAiTelemetry(),
          undefined
        )
      ).rejects.toThrow(ChatValidationError);
      expect(llmService.wasCalled()).toBe(false); // Should not call LLM
    });

    it("should apply conversation history trimming", async () => {
      // Arrange - create messages that exceed total limit
      const messages = [
        createLongMessage(2000, "user"), // Will be trimmed
        createLongMessage(2000, "assistant"), // Will be trimmed
        createLongMessage(2000, "user"), // Will be kept
        createLongMessage(1000, "assistant"), // Will be kept
      ];
      const llmService = new FakeLlmService();
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert - should trim to fit MAX_MESSAGE_CHARS (4000)
      const payload = llmService.getLastCall();
      expect(payload?.messages.length).toBeLessThan(5); // system + fewer user/assistant messages

      // Critical invariant: exactly one system message even after trimming
      const systemMessages = payload?.messages.filter(
        (m) => m.role === "system"
      );
      expect(systemMessages).toHaveLength(1);
      expect(payload?.messages[0]?.role).toBe("system");
      expect(payload?.messages[0]?.content).toContain("You are Cogni");

      // Calculate total length of passed messages
      const totalLength =
        payload?.messages.reduce((sum, msg) => {
          return sum + Array.from(msg.content).length;
        }, 0) ?? 0;
      expect(totalLength).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 500); // +buffer for system prompt
    });

    it("should not mutate original messages array", async () => {
      // Arrange
      const originalMessages = createMixedRoleConversation();
      const messagesCopy = JSON.parse(JSON.stringify(originalMessages));
      const llmService = new FakeLlmService();
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      await execute(
        originalMessages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert
      expect(originalMessages).toEqual(messagesCopy);
    });

    it("should set timestamp from injected clock", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const llmService = new FakeLlmService({ responseContent: "Hi there" });
      const fixedTime = "2025-12-25T10:30:00.000Z";
      const clock = new FakeClock(fixedTime);
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      const result = await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert
      expect(result.message.timestamp).toBe(fixedTime);
    });

    it("should use ctx.reqId for telemetry requestId (P0 stability)", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const llmService = new FakeLlmService({ responseContent: "Hi there" });
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "stable-request-id-12345",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };
      const telemetry = createFakeAiTelemetry();

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      const result = await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        telemetry,
        undefined
      );

      // Assert - P0 invariants
      // 1. Returned requestId equals ctx.reqId
      expect(result.requestId).toBe(testCtx.reqId);

      // 2. Telemetry records ctx.reqId
      const lastInvocation = telemetry.getLast();
      expect(lastInvocation).toBeDefined();
      expect(lastInvocation?.requestId).toBe(testCtx.reqId);

      // Note: Billing now occurs via RunEventRelay → commitUsageFact() (per GRAPH_EXECUTION.md)
    });

    it("should use adapter promptHash when available (canonical hash)", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const adapterPromptHash =
        "adapter-canonical-hash-64chars-padded-to-64-chars-1234567890abc";
      const llmService = new FakeLlmService({
        responseContent: "Hi there",
        promptHash: adapterPromptHash, // Adapter returns its canonical hash
      });
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };
      const telemetry = createFakeAiTelemetry();

      // Act
      const accountService = createMockAccountServiceWithDefaults();
      await execute(
        messages,
        TEST_MODEL_ID,
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        telemetry,
        undefined
      );

      // Assert - Telemetry should use adapter's hash (source of truth)
      const lastInvocation = telemetry.getLast();
      expect(lastInvocation).toBeDefined();
      expect(lastInvocation?.promptHash).toBe(adapterPromptHash);
    });

    it("should propagate LLM service errors", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const llmService = new FakeLlmService({
        shouldThrow: true,
        errorMessage: "LLM service unavailable",
      });
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Act & Assert
      const accountService = createMockAccountServiceWithDefaults();
      await expect(
        execute(
          messages,
          TEST_MODEL_ID,
          llmService,
          accountService,
          clock,
          caller,
          testCtx,
          createFakeAiTelemetry(),
          undefined
        )
      ).rejects.toThrow("LLM service unavailable");
    });

    it("should allow free model execution with zero balance", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const llmService = new FakeLlmService({
        responseContent: "Free response",
      });
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Mock account service with 0 balance
      const accountService = createMockAccountServiceWithDefaults();
      accountService.getBalance = vi.fn().mockResolvedValue(0);

      // Act
      const result = await execute(
        messages,
        "free-model", // Matches mock for isModelFree=true
        llmService,
        accountService,
        clock,
        caller,
        testCtx,
        createFakeAiTelemetry(),
        undefined
      );

      // Assert
      expect(result.message.content).toBe("Free response");
      expect(llmService.wasCalled()).toBe(true);

      // Note: Billing (including free model receipts) now occurs via RunEventRelay
    });

    it("should block paid model execution with zero balance", async () => {
      // Arrange
      const messages = [createUserMessage("Hello")];
      const llmService = new FakeLlmService();
      const clock = new FakeClock();
      const caller = createTestCaller();
      const testCtx: RequestContext = {
        log: makeNoopLogger(),
        reqId: "test-req-123",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock,
      };

      // Mock account service with 0 balance
      const accountService = createMockAccountServiceWithDefaults();
      accountService.getBalance = vi.fn().mockResolvedValue(0);

      // Act & Assert
      await expect(
        execute(
          messages,
          "paid-model", // Matches mock for isModelFree=false
          llmService,
          accountService,
          clock,
          caller,
          testCtx,
          createFakeAiTelemetry(),
          undefined
        )
      ).rejects.toThrow(InsufficientCreditsPortError);

      expect(llmService.wasCalled()).toBe(false);
    });
  });
});
