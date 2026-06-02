// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/sandbox/gateway-session-key.test`
 * Purpose: Verify gateway session key uses stateKey for multi-turn continuity.
 * Scope: Unit tests for SandboxGraphProvider gateway execution path. Does not test ephemeral mode or billing.
 * Invariants:
 *   - Gateway session key derived from stateKey (stable per conversation), not runId
 *   - stateKey is required for gateway mode — throws if missing
 *   - Session key format: agent:main:${billingAccountId}:${stateKey}
 * Side-effects: none (mocked gateway client)
 * Links: sandbox-graph.provider.ts, docs/research/openclaw-thread-persistence-duplication.md
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import { describe, expect, it, vi } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import type { OpenClawGatewayClient } from "@/adapters/server/sandbox/openclaw-gateway-client";

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

/** Drain an async iterable, collecting all yielded values. */
async function drainStream(stream: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const e of stream) {
    events.push(e);
  }
  return events;
}

/** Stub runner that should never be called in gateway mode. */
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
    ...overrides,
  } as GraphRunRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SandboxGraphProvider gateway session key", () => {
  it("throws when stateKey is missing from gateway request", async () => {
    await runInScope(TEST_SCOPE, async () => {
      const mockClient = {
        configureSession: vi.fn(),
        runAgent: vi.fn(),
      } as unknown as OpenClawGatewayClient;

      const provider = new SandboxGraphProvider(stubRunner, mockClient);
      const req = makeRequest({ stateKey: undefined });

      const { stream } = provider.runGraph(req);

      await expect(drainStream(stream)).rejects.toThrow(
        "stateKey is required for gateway execution"
      );
    });
  });

  it("uses stateKey (not runId) in gateway session key", async () => {
    await runInScope(TEST_SCOPE, async () => {
      const configureSessionSpy = vi.fn().mockResolvedValue(undefined);

      // Gateway client that yields a single text response then finishes
      async function* fakeRunAgent(): AsyncGenerator<
        | { type: "text_delta"; text: string }
        | { type: "chat_final"; text: string }
      > {
        yield { type: "text_delta", text: "Hi" };
        yield { type: "chat_final", text: "Hi" };
      }

      const mockClient = {
        configureSession: configureSessionSpy,
        runAgent: vi.fn().mockReturnValue(fakeRunAgent()),
      } as unknown as OpenClawGatewayClient;

      // Billing reader that returns entries so the provider doesn't throw
      const mockBillingReader = {
        readEntries: vi
          .fn()
          .mockResolvedValue([{ litellmCallId: "call-1", costUsd: 0.001 }]),
      };

      const provider = new SandboxGraphProvider(
        stubRunner,
        mockClient,
        mockBillingReader as never
      );

      const req = makeRequest({
        stateKey: "thread-abc-456",
        runId: "run-different-789",
      });

      const { stream } = provider.runGraph(req);
      await drainStream(stream);

      // configureSession is called first with the session key
      expect(configureSessionSpy).toHaveBeenCalledOnce();
      const [sessionKey] = configureSessionSpy.mock.calls[0] ?? [];

      // Session key must contain stateKey, NOT runId
      expect(sessionKey).toBe("agent:main:ba-acct-42:thread-abc-456");
      expect(sessionKey).not.toContain("run-different-789");
    });
  });

  it("session key scopes by billingAccountId + stateKey", async () => {
    const configureSessionSpy = vi.fn().mockResolvedValue(undefined);

    async function* fakeRunAgent(): AsyncGenerator<{
      type: "chat_final";
      text: string;
    }> {
      yield { type: "chat_final", text: "ok" };
    }

    const mockClient = {
      configureSession: configureSessionSpy,
      runAgent: vi.fn().mockReturnValue(fakeRunAgent()),
    } as unknown as OpenClawGatewayClient;

    const mockBillingReader = {
      readEntries: vi
        .fn()
        .mockResolvedValue([{ litellmCallId: "call-1", costUsd: 0.001 }]),
    };

    const provider = new SandboxGraphProvider(
      stubRunner,
      mockClient,
      mockBillingReader as never
    );

    // Two requests with same stateKey but different billing scopes
    const req = makeRequest({ stateKey: "same-thread" });
    const scopeAlice = {
      billing: { billingAccountId: "ba-alice", virtualKeyId: "vk-1" },
      usageSource: "litellm" as const,
    };
    const scopeBob = {
      billing: { billingAccountId: "ba-bob", virtualKeyId: "vk-2" },
      usageSource: "litellm" as const,
    };

    // Reset mock for second call
    mockClient.runAgent = vi.fn().mockReturnValue(fakeRunAgent());

    const { stream: s1 } = runInScope(scopeAlice, () => provider.runGraph(req));
    await runInScope(scopeAlice, () => drainStream(s1));

    mockClient.runAgent = vi.fn().mockReturnValue(fakeRunAgent());
    const { stream: s2 } = runInScope(scopeBob, () => provider.runGraph(req));
    await runInScope(scopeBob, () => drainStream(s2));

    const [key1] = configureSessionSpy.mock.calls[0] ?? [];
    const [key2] = configureSessionSpy.mock.calls[1] ?? [];

    // Same stateKey, different billing accounts → different session keys
    expect(key1).toBe("agent:main:ba-alice:same-thread");
    expect(key2).toBe("agent:main:ba-bob:same-thread");
    expect(key1).not.toBe(key2);
  });
});
