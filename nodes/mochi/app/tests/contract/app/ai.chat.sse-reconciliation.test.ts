// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.chat.sse-reconciliation`
 * Purpose: Verify that assistant_final reconciles truncated text_delta events in the SSE route.
 * Scope: Tests the for-await loop + reconciliation logic in route.ts with a synthetic AiEvent stream. Does NOT test real OpenClaw, LiteLLM, or model responses — purely tests the SSE boundary.
 * Invariants:
 *   - When deltas are truncated, assistant_final fills the gap → client receives full text
 *   - When deltas are complete, assistant_final is a no-op → no duplicate text
 *   - Reconstructed text from SSE always matches assistant_final content
 * Side-effects: none (all I/O mocked)
 * Links: src/app/api/v1/ai/chat/route.ts, work/handoffs/bug.0011.handoff.md
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamFinalResult } from "@/features/ai/types";

// ─── Mocks (must be before imports that use mocked modules) ──────────────────

// Mock bootstrap container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: {
      now: vi.fn(() => new Date("2025-01-01T00:00:00Z")),
    },
    config: {
      unhandledErrorPolicy: "rethrow",
    },
    threadPersistenceForUser: vi.fn(() => ({
      loadThread: vi.fn().mockResolvedValue([]),
      saveThread: vi.fn().mockResolvedValue(undefined),
      softDelete: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockResolvedValue([]),
    })),
  })),
  resolveAiDeps: vi.fn(),
  resolveAiAdapterDeps: vi.fn(),
}));

// Mock OTel root span — passthrough
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: vi.fn(
    async (
      _name: string,
      _attrs: Record<string, string>,
      handler: (ctx: {
        traceId: string;
        span: { setAttribute: () => void };
      }) => Promise<unknown>
    ) => {
      const noopSpan = { setAttribute: vi.fn() };
      return handler({ traceId: "test-trace-id", span: noopSpan });
    }
  ),
}));

// Mock session authentication
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

// Mock completion facade
vi.mock("@/app/_facades/ai/completion.server", () => ({
  completionStream: vi.fn(),
}));

// Mock model catalog
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelAllowed: vi.fn(),
  getDefaults: vi.fn(),
}));

// Mock observability (metrics)
vi.mock("@/shared/observability", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    aiChatStreamDurationMs: { observe: vi.fn() },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import {
  isFinishEvent,
  isTextDeltaEvent,
  readSseEvents,
} from "@tests/helpers/data-stream";
import { completionStream } from "@/app/_facades/ai/completion.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as chatPOST } from "@/app/api/v1/ai/chat/route";
import { isModelAllowed } from "@/shared/ai/model-catalog.server";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a synthetic AiEvent stream with configurable truncation. */
function createSyntheticStream(opts: {
  /** The full authoritative text (what assistant_final carries) */
  fullText: string;
  /** How many characters of the full text to deliver via text_delta events */
  deltaCharCount: number;
  /** Size of each text_delta chunk */
  chunkSize?: number;
}): { stream: AsyncIterable<AiEvent>; final: Promise<StreamFinalResult> } {
  const { fullText, deltaCharCount, chunkSize = 5 } = opts;
  const deltaText = fullText.slice(0, deltaCharCount);

  const stream = (async function* (): AsyncIterable<AiEvent> {
    // Initial yield: gives the ReadableStream backing
    // createUIMessageStream time to initialize its reader.
    // Without this, synchronous generators can race the stream close.
    // Real streams (LLM, gateway WS) always have I/O delays.
    await new Promise((r) => setTimeout(r, 0));

    // Emit text_delta events for the partial text
    for (let i = 0; i < deltaText.length; i += chunkSize) {
      yield {
        type: "text_delta",
        delta: deltaText.slice(i, i + chunkSize),
      };
      await new Promise((r) => setTimeout(r, 0));
    }

    // Emit assistant_final with the FULL text
    yield { type: "assistant_final", content: fullText };
    await new Promise((r) => setTimeout(r, 0));

    // Emit done
    yield { type: "done" };
  })();

  const final = Promise.resolve({
    ok: true as const,
    requestId: "test-req-id",
    usage: { promptTokens: 10, completionTokens: 20 },
    finishReason: "stop",
  });

  return { stream, final };
}

/** Build a valid NextRequest for the chat route (P1 format). */
function buildChatRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Hello",
      modelRef: { providerKey: "platform", modelId: "test-model" },
      graphName: "sandbox:openclaw",
    }),
  });
}

/** Collect all text deltas from an SSE response into a single string. */
async function collectTextFromResponse(res: Response): Promise<{
  text: string;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const textParts: string[] = [];

  for await (const event of readSseEvents(res)) {
    events.push(event);
    if (isTextDeltaEvent(event)) {
      textParts.push(event.data.delta as string);
    }
    if (isFinishEvent(event)) break;
  }

  return { text: textParts.join(""), events };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Chat SSE Reconciliation", () => {
  const FULL_TEXT =
    "The ocean is vast and beautiful, stretching endlessly across the horizon. " +
    "Waves crash against the shore with rhythmic precision, carrying stories from distant lands. " +
    "Beneath the surface, countless creatures inhabit a world of wonder and mystery.";

  beforeEach(() => {
    vi.resetAllMocks();

    // Default mocks
    vi.mocked(getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    vi.mocked(isModelAllowed).mockResolvedValue(true);
  });

  it("reconciles truncated deltas with assistant_final — full text arrives", async () => {
    // Arrange: deltas deliver only the first half of text
    const halfLen = Math.floor(FULL_TEXT.length / 2);
    const synthetic = createSyntheticStream({
      fullText: FULL_TEXT,
      deltaCharCount: halfLen,
    });

    vi.mocked(completionStream).mockResolvedValue(synthetic);

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text, events } = await collectTextFromResponse(res);

    // Assert: reconstructed text equals the full assistant_final content
    expect(text).toBe(FULL_TEXT);

    // Assert: finish event is present
    const hasFinish = events.some((e) => isFinishEvent(e));
    expect(hasFinish).toBe(true);

    // Assert: multiple text deltas arrived (chunked streaming + reconciliation)
    const deltaCount = events.filter((e) => isTextDeltaEvent(e)).length;
    expect(deltaCount).toBeGreaterThan(1);
  });

  it("no-op reconciliation when all deltas arrive complete", async () => {
    // Arrange: deltas deliver the full text
    const synthetic = createSyntheticStream({
      fullText: FULL_TEXT,
      deltaCharCount: FULL_TEXT.length,
    });

    vi.mocked(completionStream).mockResolvedValue(synthetic);

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text } = await collectTextFromResponse(res);

    // Assert: text matches exactly (no duplicate from reconciliation)
    expect(text).toBe(FULL_TEXT);
  });

  it("handles severely truncated deltas — only 10 chars via delta", async () => {
    // Arrange: deltas deliver only 10 characters
    const synthetic = createSyntheticStream({
      fullText: FULL_TEXT,
      deltaCharCount: 10,
      chunkSize: 3,
    });

    vi.mocked(completionStream).mockResolvedValue(synthetic);

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text } = await collectTextFromResponse(res);

    // Assert: full text arrives despite severely truncated deltas
    expect(text).toBe(FULL_TEXT);
  });

  it("handles zero deltas — assistant_final is the only text source", async () => {
    // Arrange: no text_delta events at all
    const synthetic = createSyntheticStream({
      fullText: FULL_TEXT,
      deltaCharCount: 0,
    });

    vi.mocked(completionStream).mockResolvedValue(synthetic);

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text } = await collectTextFromResponse(res);

    // Assert: full text arrives solely from reconciliation
    expect(text).toBe(FULL_TEXT);
  });

  it("handles stream without assistant_final — deltas are all you get", async () => {
    // Arrange: stream has deltas + done but no assistant_final
    const stream = (async function* (): AsyncIterable<AiEvent> {
      yield { type: "text_delta", delta: "Hello " };
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "text_delta", delta: "world" };
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "done" };
    })();

    vi.mocked(completionStream).mockResolvedValue({
      stream,
      final: Promise.resolve({
        ok: true as const,
        requestId: "test-req-id",
        usage: { promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text } = await collectTextFromResponse(res);

    // Assert: text is just what deltas provided (no reconciliation)
    expect(text).toBe("Hello world");
  });

  it("StatusEvent emits transient data-status chunk — not persisted (STATUS_IS_EPHEMERAL)", async () => {
    // Arrange: stream includes status events between text events
    const stream = (async function* (): AsyncIterable<AiEvent> {
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "status", phase: "thinking" } as AiEvent;
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "text_delta", delta: "Hello" };
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "status", phase: "tool_use", label: "exec" } as AiEvent;
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "status", phase: "thinking" } as AiEvent;
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "text_delta", delta: " world" };
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "assistant_final", content: "Hello world" };
      await new Promise((r) => setTimeout(r, 0));
      yield { type: "done" };
    })();

    vi.mocked(completionStream).mockResolvedValue({
      stream,
      final: Promise.resolve({
        ok: true as const,
        requestId: "test-req-id",
        usage: { promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    // Act
    const res = await chatPOST(buildChatRequest());
    expect(res.status).toBe(200);

    const { text, events } = await collectTextFromResponse(res);

    // Assert: text is correct (status events don't interfere)
    expect(text).toBe("Hello world");

    // Assert: data-status events appear in the SSE stream
    const statusEvents = events.filter((e) => e.type === "data-status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    // Assert: status events have transient flag and phase data
    for (const se of statusEvents) {
      expect(se.data).toHaveProperty("transient", true);
      expect(se.data).toHaveProperty("data");
      const innerData = se.data.data as Record<string, unknown>;
      expect(innerData).toHaveProperty("phase");
      expect(["thinking", "tool_use", "compacting"]).toContain(innerData.phase);
    }

    // Assert: at least one tool_use status with label
    const toolStatus = statusEvents.find(
      (e) => (e.data.data as Record<string, unknown>)?.phase === "tool_use"
    );
    if (toolStatus) {
      expect((toolStatus.data.data as Record<string, unknown>).label).toBe(
        "exec"
      );
    }
  });

  it("finish event includes finishReason from final promise", async () => {
    const synthetic = createSyntheticStream({
      fullText: "short",
      deltaCharCount: 5,
    });

    vi.mocked(completionStream).mockResolvedValue(synthetic);

    // Act
    const res = await chatPOST(buildChatRequest());
    const { events } = await collectTextFromResponse(res);

    // Assert: finish event has expected finishReason
    const finish = events.find((e) => isFinishEvent(e));
    expect(finish).toBeDefined();
    expect(finish?.data).toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
  });
});
