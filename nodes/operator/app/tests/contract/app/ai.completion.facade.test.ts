// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { chatCompletionsContract } from "@cogni/node-contracts";
import {
  createMockAccountServiceWithDefaults,
  FakeAiTelemetryAdapter,
  FakeClock,
  TEST_SESSION_USER_1,
} from "@tests/_fakes";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/fakes";
import { createRunStreamMock } from "@tests/_fixtures/ai/completion-facade-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "@/app/_facades/ai/completion.server";
import type { RequestContext } from "@/shared/observability";
import { makeNoopLogger } from "@/shared/observability";

const startMock = vi.fn().mockResolvedValue({});

// vi.mock factories are hoisted — can't reference module imports.
// Keep inline; fixture used in non-hoisted test helpers.
vi.mock("@/shared/config", () => ({
  getNodeId: () => "test-node-id",
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: vi.fn(),
  getTemporalWorkflowClient: vi.fn(async () => ({
    client: { start: startMock },
    taskQueue: "scheduler-tasks",
  })),
  getContainer: vi.fn(() => ({
    runStream: {
      subscribe: async function* () {
        yield {
          id: "1-0",
          event: { type: "text_delta" as const, delta: "AI response" },
        };
        yield {
          id: "2-0",
          event: { type: "assistant_final" as const, content: "AI response" },
        };
        yield {
          id: "3-0",
          event: {
            type: "done" as const,
            usage: { promptTokens: 10, completionTokens: 20 },
            finishReason: "stop",
          },
        };
      },
    },
  })),
}));

import { getContainer, resolveAiAdapterDeps } from "@/bootstrap/container";

const mockResolveAiAdapterDeps = vi.mocked(resolveAiAdapterDeps);

describe("app/_facades/ai/completion.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fakeClock = new FakeClock("2025-01-01T12:00:00.000Z");
    mockResolveAiAdapterDeps.mockReturnValue({
      llmService: {} as never,
      accountService: createMockAccountServiceWithDefaults(),
      clock: fakeClock,
      aiTelemetry: new FakeAiTelemetryAdapter(),
      langfuse: undefined,
    });
  });

  it("returns OpenAI-compatible completion output", async () => {
    const testCtx: RequestContext = {
      log: makeNoopLogger(),
      reqId: "test-req-123",
      traceId: "00000000000000000000000000000000",
      routeId: "test.route",
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
    };

    const result = await chatCompletion(
      {
        messages: [{ role: "user", content: "Hello" }],
        modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:poet",
      },
      testCtx
    );

    expect(() => chatCompletionsContract.output.parse(result)).not.toThrow();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(result.choices[0]?.message.content).toBe("AI response");
  });

  it("keeps a fresh-v2 actor principal through authorization and workflow input", async () => {
    const actorId = "00000000-0000-4000-8000-000000005264";
    const billingAccountId = "00000000-0000-4000-8000-000000005263";
    const actorPrincipalId = `agent:test-node-id/${actorId}`;
    const authorizationCheck = vi.fn().mockResolvedValue({
      decision: "allow",
      code: "allowed",
    });
    vi.mocked(getContainer).mockReturnValue({
      authorization: { check: authorizationCheck },
      serviceAccountService: {
        getBillingAccountById: vi.fn().mockResolvedValue({
          id: billingAccountId,
          ownerUserId: TEST_SESSION_USER_1.id,
          balanceCredits: 100,
          defaultVirtualKeyId: "test-vk-id",
        }),
      },
      runStream: {
        subscribe: async function* () {
          yield {
            id: "1-0",
            event: { type: "assistant_final" as const, content: "AI response" },
          };
          yield { id: "2-0", event: { type: "done" as const } };
        },
      },
    } as never);

    const principal = {
      kind: "agent" as const,
      principalId: actorPrincipalId,
      actorId,
      credentialId: "00000000-0000-4000-8000-000000005265",
      billingAccountId,
      legacyUserId: null,
      displayName: "fresh-v2",
    };
    const completionInput = {
      messages: [{ role: "user" as const, content: "Hello" }],
      modelRef: {
        providerKey: "platform" as const,
        modelId: TEST_MODEL_ID,
      },
      principal,
      graphName: "langgraph:poet",
    };
    const result = await chatCompletion(
      completionInput,
      {
        log: makeNoopLogger(),
        reqId: "agent-req-5264",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock: new FakeClock("2025-01-01T12:00:00.000Z"),
      }
    );
    await chatCompletion(
      {
        ...completionInput,
        principal: {
          ...principal,
          credentialId: "00000000-0000-4000-8000-000000005266",
        },
      },
      {
        log: makeNoopLogger(),
        reqId: "agent-req-5264-rotated",
        traceId: "00000000000000000000000000000000",
        routeId: "test.route",
        clock: new FakeClock("2025-01-01T12:00:00.000Z"),
      }
    );

    expect(result.choices[0]?.message.content).toBe("AI response");
    expect(authorizationCheck).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actorPrincipalId })
    );
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(startMock).toHaveBeenLastCalledWith(
      "GraphRunWorkflow",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            requestedBy: actorId,
            input: expect.objectContaining({
              actorUserId: actorId,
              actorPrincipalId,
              billingAccountId,
            }),
          }),
        ],
      })
    );
    expect(JSON.stringify(startMock.mock.calls)).not.toContain("005265");
    expect(JSON.stringify(startMock.mock.calls)).not.toContain("005266");
  });

  it("propagates stream errors to final response", async () => {
    vi.mocked(resolveAiAdapterDeps).mockReturnValueOnce({
      llmService: {} as never,
      accountService: createMockAccountServiceWithDefaults(),
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
      aiTelemetry: new FakeAiTelemetryAdapter(),
      langfuse: undefined,
    });

    const { getContainer } = await import("@/bootstrap/container");
    vi.mocked(getContainer).mockReturnValueOnce({
      runStream: createRunStreamMock({
        responseContent: "",
        emitError: "internal",
      }),
    } as never);

    const testCtx: RequestContext = {
      log: makeNoopLogger(),
      reqId: "test-req-456",
      traceId: "00000000000000000000000000000000",
      routeId: "test.route",
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
    };

    await expect(
      chatCompletion(
        {
          messages: [{ role: "user", content: "Hello" }],
          modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
          sessionUser: TEST_SESSION_USER_1,
          graphName: "langgraph:poet",
        },
        testCtx
      )
    ).rejects.toThrow("AI execution failed: internal");
  });
});
