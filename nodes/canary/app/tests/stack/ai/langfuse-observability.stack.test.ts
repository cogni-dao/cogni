// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/langfuse-observability.stack`
 * Purpose: Verify Langfuse observability integration per OBSERVABILITY.md invariants.
 * Scope: Tests ObservabilityGraphExecutorDecorator behavior via /api/v1/ai/chat endpoint. Does not test Langfuse SDK internals.
 * Invariants:
 *   - LANGFUSE_NON_NULL_IO: Traces have non-null scrubbed input/output
 *   - LANGFUSE_TERMINAL_ONCE_GUARD: Exactly one terminal outcome per trace
 *   - LANGFUSE_OTEL_TRACE_CORRELATION: Uses OTel traceId as Langfuse trace ID
 *   - LANGFUSE_SCRUB_BEFORE_SEND: All content scrubbed before Langfuse
 *   - LANGFUSE_SESSION_LIMIT: sessionId truncated to <=200 chars
 *   - LANGFUSE_TOOL_SPANS_NOT_LOGS: Tool spans visible, not logged
 * Side-effects: IO (database writes, spy captures)
 * Notes: Requires dev stack running (pnpm dev:stack:test). Uses SpyLangfusePort to capture calls.
 * Links: docs/spec/observability.md#langfuse-integration, AI_SETUP_SPEC.md
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import { createChatRequest } from "@tests/_fakes";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { isFinishEvent, readSseEvents } from "@tests/helpers/data-stream";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as chatPOST } from "@/app/api/v1/ai/chat/route";
import { GET as modelsGET } from "@/app/api/v1/ai/models/route";
import type {
  CreateTraceWithIOParams,
  LangfusePort,
  LangfuseSpanHandle,
} from "@/ports";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

/**
 * Spy implementation of LangfusePort that captures all calls.
 */
class SpyLangfusePort implements LangfusePort {
  readonly traces: {
    traceId: string;
    metadata: { requestId: string; model: string; promptHash: string };
  }[] = [];

  readonly tracesWithIO: CreateTraceWithIOParams[] = [];
  readonly traceOutputs: { traceId: string; output: unknown }[] = [];
  readonly spans: {
    traceId: string;
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    output?: unknown;
    level?: string;
  }[] = [];
  readonly generations: { traceId: string; generation: unknown }[] = [];
  readonly flushCalls: number[] = [];

  async createTrace(
    traceId: string,
    metadata: { requestId: string; model: string; promptHash: string }
  ): Promise<string> {
    this.traces.push({ traceId, metadata });
    return traceId;
  }

  recordGeneration(
    traceId: string,
    generation: {
      model: string;
      tokensIn?: number;
      tokensOut?: number;
      latencyMs: number;
      status: "success" | "error";
      input?: unknown;
      output?: unknown;
    }
  ): void {
    this.generations.push({ traceId, generation });
  }

  async flush(): Promise<void> {
    this.flushCalls.push(Date.now());
  }

  createTraceWithIO(params: CreateTraceWithIOParams): string {
    this.tracesWithIO.push(params);
    return params.traceId;
  }

  updateTraceOutput(traceId: string, output: unknown): void {
    this.traceOutputs.push({ traceId, output });
  }

  startSpan(params: {
    traceId: string;
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseSpanHandle {
    const spanEntry = { ...params, output: undefined, level: undefined };
    this.spans.push(spanEntry);

    return {
      spanId: `span_${Date.now()}`,
      end: (endParams) => {
        spanEntry.output = endParams.output;
        spanEntry.level = endParams.level;
      },
    };
  }

  reset(): void {
    this.traces.length = 0;
    this.tracesWithIO.length = 0;
    this.traceOutputs.length = 0;
    this.spans.length = 0;
    this.generations.length = 0;
    this.flushCalls.length = 0;
  }
}

// Global spy instance - will be wired into container
const langfuseSpy = new SpyLangfusePort();

// Mock the container to inject our spy
vi.mock("@/bootstrap/container", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/bootstrap/container")>();

  return {
    ...original,
    getContainer: vi.fn(() => {
      const realContainer = original.getContainer();
      return {
        ...realContainer,
        langfuse: langfuseSpy,
      };
    }),
    resolveAiAdapterDeps: vi.fn((userId: import("@cogni/ids").UserId) => {
      const realDeps = original.resolveAiAdapterDeps(userId);
      return {
        ...realDeps,
        langfuse: langfuseSpy,
      };
    }),
  };
});

// QUARANTINED(task.0185): After Temporal+Redis migration, the facade no longer calls
// GraphExecutorPort inline — spies injected here don't reach the decorator stack.
// Replace with internal-route-level tests + black-box smoke tests per task.0185.
describe.skip("Langfuse Observability Stack Tests", () => {
  beforeEach(() => {
    langfuseSpy.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("LANGFUSE_NON_NULL_IO invariant", () => {
    it("creates trace with non-null scrubbed input", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      // Fetch valid model
      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hello, please respond briefly.",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      // Consume stream
      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - Trace was created with non-null input
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const trace = langfuseSpy.tracesWithIO[0];
      expect(trace).toBeDefined();
      expect(trace?.input).not.toBeNull();
      expect(trace?.input).not.toBeUndefined();

      // Input should be scrubbed structure (ScrubbedTraceInput)
      const input = trace?.input as Record<string, unknown>;
      expect(input).toHaveProperty("messageCount");
      expect(input).toHaveProperty("contentHash");
    });

    it("updates trace with non-null scrubbed output on success", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Say hello",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      // Consume stream
      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - Output was set on terminal
      expect(langfuseSpy.traceOutputs.length).toBe(1);
      const output = langfuseSpy.traceOutputs[0];
      expect(output).toBeDefined();
      expect(output?.output).not.toBeNull();
      expect(output?.output).not.toBeUndefined();

      // Output should be scrubbed structure (ScrubbedTraceOutput)
      const outputData = output?.output as Record<string, unknown>;
      expect(outputData).toHaveProperty("status");
      expect(outputData.status).toBe("success");
    });
  });

  describe("LANGFUSE_OTEL_TRACE_CORRELATION invariant", () => {
    it("uses valid 32-hex traceId for Langfuse trace", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hi",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - traceId is valid 32-hex format
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const traceId = langfuseSpy.tracesWithIO[0]?.traceId;
      expect(traceId).toMatch(/^[a-f0-9]{32}$/);

      // Not all-zeros (proves OTel SDK is running)
      expect(traceId).not.toBe("00000000000000000000000000000000");
    });
  });

  describe("LANGFUSE_SESSION_LIMIT invariant", () => {
    it("truncates sessionId to 200 chars", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Use a very long stateKey (which becomes sessionId via hash)
      const longStateKey = "a".repeat(128);

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Test",
            modelRef: modelRef,
            stateKey: longStateKey,
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - sessionId is truncated to 200 chars
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const sessionId = langfuseSpy.tracesWithIO[0]?.sessionId;

      if (sessionId) {
        expect(sessionId.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("LANGFUSE_TERMINAL_ONCE_GUARD invariant", () => {
    it("calls updateTraceOutput exactly once on success", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hello",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - Exactly one trace output update
      expect(langfuseSpy.traceOutputs.length).toBe(1);

      // And at least one flush for this trace
      expect(langfuseSpy.flushCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("trace metadata", () => {
    it("includes graphId in tags", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hello",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - Tags include graphId and environment
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const tags = langfuseSpy.tracesWithIO[0]?.tags;
      expect(tags).toBeDefined();
      expect(Array.isArray(tags)).toBe(true);
      // Should have at least provider, graphName, environment
      expect(tags?.length).toBeGreaterThanOrEqual(2);
    });

    it("includes userId in metadata (not as tag)", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hello",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - userId passed to trace (as top-level param, not in tags)
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const trace = langfuseSpy.tracesWithIO[0];

      // userId should be on trace params, NOT in tags
      // The decorator passes userId as caller.userId to createTraceWithIO
      // If userId was passed, it's available as top-level param
      // Tags should NOT contain the userId (per spec)
      const tags = trace?.tags ?? [];
      expect(tags).not.toContain(user.id);
    });

    it("includes billingAccountId in metadata", async () => {
      // Arrange
      const db = getSeedDb();
      const { user, billingAccount } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hello",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - billingAccountId in metadata
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const metadata = langfuseSpy.tracesWithIO[0]?.metadata;
      expect(metadata).toBeDefined();
      expect(metadata?.billingAccountId).toBe(billingAccount.id);
    });
  });

  describe("LANGFUSE_SCRUB_BEFORE_SEND invariant", () => {
    it("scrubs sensitive content from input", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Message with potentially sensitive content
      // sk- pattern requires 20+ alphanumeric chars to be scrubbed
      const sensitiveApiKey = "sk-abcdefghij1234567890abcdef";
      const sensitiveMessage = `My API key is ${sensitiveApiKey}`;

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: sensitiveMessage,
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert - Input is scrubbed
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      const input = langfuseSpy.tracesWithIO[0]?.input as Record<
        string,
        unknown
      >;

      // Scrubbed input should have contentHash (proves scrubbing ran)
      expect(input).toHaveProperty("contentHash");
      expect(typeof input.contentHash).toBe("string");

      // If lastUserMessage is present, sensitive content should be redacted
      if (input.lastUserMessage) {
        const lastMsg = input.lastUserMessage as string;
        // sk-xxx patterns (20+ chars) should be redacted to [REDACTED_SK_KEY]
        expect(lastMsg).not.toContain(sensitiveApiKey);
        expect(lastMsg).toContain("[REDACTED_SK_KEY]");
      }
    });
  });

  // TODO: Add full integration test with real LiteLLM (not FakeLlmAdapter) to verify
  // LiteLLM's Langfuse callback attaches generations to app-created trace via existing_trace_id.
  // Current stack tests use APP_ENV=test with FakeLlmAdapter, which doesn't hit LiteLLM.
  describe.skip("GENERATION_UNDER_EXISTING_TRACE contract", () => {
    it("records generation with tokens under graph-execution trace (same traceId)", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Say hello briefly.",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      // Consume stream fully
      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert: One trace via createTraceWithIO (graph-execution), NOT createTrace (llm-completion)
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      expect(langfuseSpy.traces.length).toBe(0); // No llm-completion traces

      // Assert: Generation recorded with same traceId as the trace
      expect(langfuseSpy.generations.length).toBe(1);
      const trace = langfuseSpy.tracesWithIO[0];
      const generation = langfuseSpy.generations[0];

      expect(generation?.traceId).toBe(trace?.traceId);

      // Assert: Generation has token counts > 0
      const genData = generation?.generation as {
        tokensIn?: number;
        tokensOut?: number;
        status: string;
      };
      expect(genData?.status).toBe("success");
      expect(genData?.tokensIn).toBeGreaterThan(0);
      expect(genData?.tokensOut).toBeGreaterThan(0);
    });

    it("generation traceId matches trace output traceId", async () => {
      // Arrange
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(
        db,
        { id: randomUUID() },
        { balanceCredits: 100_000_000 }
      );

      if (!user.walletAddress) throw new Error("walletAddress required");

      const mockSessionUser: SessionUser = {
        id: user.id,
        walletAddress: user.walletAddress,
      };
      vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

      const modelsReq = new NextRequest(
        "http://localhost:3000/api/v1/ai/models"
      );
      const modelsRes = await modelsGET(modelsReq);
      const { defaultRef: modelRef } = await modelsRes.json();

      // Act
      const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createChatRequest({
            message: "Hi",
            modelRef: modelRef,
            stateKey: randomUUID(),
          })
        ),
      });

      const res = await chatPOST(req);
      expect(res.status).toBe(200);

      for await (const e of readSseEvents(res)) {
        if (isFinishEvent(e)) break;
      }

      // Assert: All three calls use the same traceId
      expect(langfuseSpy.tracesWithIO.length).toBe(1);
      expect(langfuseSpy.traceOutputs.length).toBe(1);
      expect(langfuseSpy.generations.length).toBe(1);

      const traceId = langfuseSpy.tracesWithIO[0]?.traceId;
      expect(langfuseSpy.traceOutputs[0]?.traceId).toBe(traceId);
      expect(langfuseSpy.generations[0]?.traceId).toBe(traceId);
    });
  });
});
