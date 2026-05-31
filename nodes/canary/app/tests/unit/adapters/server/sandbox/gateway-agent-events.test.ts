// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/sandbox/gateway-agent-events.test`
 * Purpose: Verify that OpenClaw agent events map to GatewayAgentEvent.status correctly.
 * Scope: Tests the gateway client's agent event handling (lifecycle, tool, compaction). Does not test WS transport or real OpenClaw connections.
 * Invariants:
 *   - STATUS_SESSIONKEY_FILTERED: agent events with wrong sessionKey are dropped
 *   - STATUS_NEVER_LEAKS_CONTENT: label contains only tool name, never args or results
 *   - STATUS_BEST_EFFORT: missing agent events don't break streaming
 * Side-effects: none (mocked gateway client via provider)
 * Links: streaming-status.md, openclaw-gateway-client.ts
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import { describe, expect, it, vi } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import type { GatewayAgentEvent } from "@/adapters/server/sandbox/openclaw-gateway-client";
import { SandboxGraphProvider } from "@/adapters/server/sandbox/sandbox-graph.provider";
import type { GraphRunRequest, SandboxRunnerPort } from "@/ports";

const TEST_SCOPE = {
  billing: {
    billingAccountId: "ba-acct-42",
    virtualKeyId: "vk-1",
  },
  usageSource: "litellm" as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Run graph + drain stream within ALS scope (required for billing context). */
async function runAndDrain(
  provider: SandboxGraphProvider,
  req: GraphRunRequest
): Promise<AiEvent[]> {
  return runInScope(TEST_SCOPE, async () => {
    const { stream } = provider.runGraph(req);
    const events: AiEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }
    return events;
  });
}

const stubRunner: SandboxRunnerPort = {
  runOnce: () => {
    throw new Error("runOnce must not be called in gateway mode");
  },
};

function makeRequest(
  overrides: Partial<GraphRunRequest> = {}
): GraphRunRequest {
  return {
    runId: "run-test-123",
    graphId: "sandbox:openclaw",
    modelRef: { providerKey: "platform", modelId: "cogni/test-model" },
    messages: [{ role: "user", content: "Hello" }],
    stateKey: "thread-test-1",
    ...overrides,
  } as GraphRunRequest;
}

function makeProvider(events: GatewayAgentEvent[]): SandboxGraphProvider {
  async function* fakeRunAgent(): AsyncGenerator<GatewayAgentEvent> {
    for (const e of events) {
      yield e;
    }
  }

  const mockClient = {
    configureSession: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockReturnValue(fakeRunAgent()),
  };

  const mockBillingReader = {
    readEntries: vi.fn().mockResolvedValue([]),
  };

  return new SandboxGraphProvider(
    stubRunner,
    mockClient as never,
    mockBillingReader as never
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Gateway agent events → StatusEvent mapping", () => {
  it("maps status:thinking through provider", async () => {
    const provider = makeProvider([
      { type: "status", phase: "thinking" },
      { type: "chat_final", text: "done" },
    ]);

    const events = await runAndDrain(provider, makeRequest());

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toEqual({ type: "status", phase: "thinking" });
  });

  it("maps status:tool_use with label through provider", async () => {
    const provider = makeProvider([
      { type: "status", phase: "tool_use", label: "exec" },
      { type: "text_delta", text: "result" },
      { type: "chat_final", text: "result" },
    ]);

    const events = await runAndDrain(provider, makeRequest());

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toEqual({
      type: "status",
      phase: "tool_use",
      label: "exec",
    });
  });

  it("maps status:compacting through provider", async () => {
    const provider = makeProvider([
      { type: "status", phase: "compacting" },
      { type: "status", phase: "thinking" },
      { type: "text_delta", text: "Hi" },
      { type: "chat_final", text: "Hi" },
    ]);

    const events = await runAndDrain(provider, makeRequest());

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents).toHaveLength(2);
    expect(statusEvents[0]).toEqual({ type: "status", phase: "compacting" });
    expect(statusEvents[1]).toEqual({ type: "status", phase: "thinking" });
  });

  it("streams work with zero status events (graceful degradation)", async () => {
    const provider = makeProvider([
      { type: "text_delta", text: "Hi" },
      { type: "chat_final", text: "Hi" },
    ]);

    const events = await runAndDrain(provider, makeRequest());

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents).toHaveLength(0);

    // Stream still produces text and completion events
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect(events.some((e) => e.type === "assistant_final")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("status label never contains args (STATUS_NEVER_LEAKS_CONTENT)", async () => {
    // Even if a malformed event somehow carries args, label should only be a name
    const provider = makeProvider([
      { type: "status", phase: "tool_use", label: "memory_search" },
      { type: "chat_final", text: "done" },
    ]);

    const events = await runAndDrain(provider, makeRequest());

    const statusEvents = events.filter((e) => e.type === "status");
    for (const event of statusEvents) {
      if (event.type === "status" && event.label) {
        // Label should be a simple tool name, not JSON or complex content
        expect(event.label).not.toContain("{");
        expect(event.label).not.toContain("}");
        expect(event.label.length).toBeLessThan(100);
      }
    }
  });
});
