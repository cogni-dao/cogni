// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/inproc.provider`
 * Purpose: Wiring tests for LangGraphInProcProvider - adapter integration and error handling.
 * Scope: Exercises provider wiring and the brain graph's guarded tool loop with scripted completions. No external LLM calls.
 * Invariants:
 *   - Valid graphId: events reflect adapter stream
 *   - Invalid graphId: emits client error (not_found), done is last
 * Side-effects: none (all mocked)
 * Links: inproc.provider.ts, GRAPH_EXECUTION.md
 * @internal
 */

import type { AiEvent, BoundToolRuntime, ToolSourcePort } from "@cogni/ai-core";
import { AiExecutionError } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  TOOL_CATALOG,
  toBoundToolRuntime,
} from "@cogni/ai-tools";
import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import type { AgentGrantsStore, GuardDeps } from "@cogni-dao/agent-grants";
import { describe, expect, it, vi } from "vitest";

// Pass-through spy so the provider's tool-runner config can be asserted (authz v0).
const toolRunnerSpy = vi.hoisted(() => ({
  calls: [] as unknown[][],
  runners: [] as ReturnType<typeof import("@cogni/ai-core").createToolRunner>[],
}));
vi.mock("@cogni/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/ai-core")>();
  return {
    ...actual,
    createToolRunner: (...args: Parameters<typeof actual.createToolRunner>) => {
      toolRunnerSpy.calls.push(args);
      const runner = actual.createToolRunner(...args);
      toolRunnerSpy.runners.push(runner);
      return runner;
    },
  };
});

import { runInScope } from "@/adapters/server/ai/execution-scope";
import type { CompletionUnitAdapter } from "@/adapters/server/ai/langgraph/inproc.provider";
import {
  graphReportDelta,
  graphReportLogFields,
  LangGraphInProcProvider,
  selectArchitectEntryId,
} from "@/adapters/server/ai/langgraph/inproc.provider";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import type { GraphRunRequest } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

const TEST_SCOPE = {
  billing: {
    billingAccountId: "test-billing",
    virtualKeyId: "test-vkey",
  },
  usageSource: "litellm" as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all events from stream into array.
 */
async function collectEvents(
  stream: AsyncIterable<AiEvent>
): Promise<AiEvent[]> {
  return runInScope(TEST_SCOPE, async () => {
    const events: AiEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  });
}

/**
 * Create a mock CompletionUnitAdapter with controlled event stream.
 */
function createMockAdapter(options?: {
  events?: AiEvent[];
  finalResult?: {
    ok: boolean;
    requestId?: string;
    usage?: { promptTokens: number; completionTokens: number };
    finishReason?: string;
    error?: string;
  };
}): CompletionUnitAdapter {
  const events = options?.events ?? [
    { type: "text_delta" as const, delta: "Test" },
  ];

  const finalResult = options?.finalResult ?? {
    ok: true,
    requestId: "test-req",
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  };

  return {
    executeCompletionUnit: vi.fn().mockReturnValue({
      stream: (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
      final: Promise.resolve(finalResult),
    }),
  };
}

/**
 * Create a mock ToolSourcePort that wraps TOOL_CATALOG with stub implementations.
 *
 * NOTE: This uses TOOL_CATALOG stubs intentionally for unit test isolation.
 * The stack test (tests/stack/ai/metrics-tool.stack.test.ts) validates real
 * capability bindings via container.toolSource with injected MetricsCapability.
 */
function createMockToolSource(): ToolSourcePort {
  // Build runtime map from catalog
  const runtimeMap = new Map(
    Object.entries(TOOL_CATALOG).map(([id, tool]) => [
      id,
      toBoundToolRuntime(tool),
    ])
  );

  return {
    getBoundTool: (toolId: string) => runtimeMap.get(toolId),
    listToolSpecs: () => Array.from(runtimeMap.values()).map((t) => t.spec),
    hasToolId: (toolId: string) => runtimeMap.has(toolId),
  };
}

/**
 * Create a minimal GraphRunRequest for testing.
 */
function createTestRequest(
  overrides?: Partial<GraphRunRequest>
): GraphRunRequest {
  return {
    runId: "test-run-id",
    messages: [{ role: "user", content: "Hello" }],
    modelRef: { providerKey: "platform", modelId: "test-model" },
    graphId: "langgraph:poet",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LangGraphInProcProvider", () => {
  it("field policy rejects before the writer with a nonretryable authority receipt", async () => {
    const patch = vi.fn();
    const capability = createWorkItemCapability({
      workItemQuery: {} as never,
      patchFields: () => ["summary"],
      backlogWriter: {
        attribution: () => ({}) as never,
        attributionDenied: vi.fn(),
        store: { patch } as never,
      },
    });
    await expect(
      capability.patch({
        id: "task.1",
        reason: "test",
        set: { outcome: "denied" },
      } as never)
    ).rejects.toMatchObject({
      receipt: {
        code: "policy_denied",
        retryable: false,
        lookup: { tool: "core__work_item_update", scope: "node.collaborate" },
      },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  describe("brain outer writer authorization is terminal", () => {
    it.each([
      "deny",
      "unavailable",
      "throw",
      "allow",
      "field",
    ] as const)("ends an offered writer after outer %s, retaining the granted control", async (decision) => {
      const toolId = "core__edo_hypothesize";
      const bound = CORE_TOOL_BUNDLE.find(
        (tool) => tool.contract.name === toolId
      );
      if (!bound) throw new Error("brain EDO contract missing");
      const writes = vi.fn(async () => ({ committed: true }));
      const fieldCapability = createWorkItemCapability({
        workItemQuery: {} as never,
        patchFields: () => ["summary"],
        backlogWriter: {
          attribution: () => ({}) as never,
          attributionDenied: vi.fn(),
          store: { patch: writes } as never,
        },
      });
      const runtime = {
        ...toBoundToolRuntime(bound),
        exec:
          decision === "field"
            ? async () =>
                fieldCapability.patch({
                  id: "task.1",
                  reason: "test",
                  set: { outcome: "denied" },
                } as never)
            : writes,
        validateOutput: (value: unknown) => value,
        redact: (value: unknown) => value,
      };
      // The actual operator hypothesis tool uses the outer legacy tool.execute
      // gate as well as the released principal/subject guard.
      expect(runtime.requires).toBeUndefined();
      const liveScopes = vi.fn(
        async (_id: string, scopes: readonly string[]) => [...scopes]
      );
      const hasLiveRole = vi.fn(async () => true);
      const authority: GuardDeps = {
        withStore: (fn) =>
          fn({ liveScopes, hasLiveRole } as unknown as AgentGrantsStore),
        adminCheck: async () => "allow",
      };
      const authorization = new FakeAuthorizationAdapter();
      const check = vi
        .spyOn(authorization, "check")
        .mockImplementation(async () => {
          if (decision === "throw")
            throw new Error("private authority outage details");
          return decision === "allow" || decision === "field"
            ? { decision: "allow", code: "authz_allowed", checks: [] }
            : {
                decision: "deny",
                code:
                  decision === "deny" ? "authz_denied" : "authz_unavailable",
                checks: [],
              };
        });
      let turns = 0;
      const adapter: CompletionUnitAdapter = {
        executeCompletionUnit: vi.fn<
          CompletionUnitAdapter["executeCompletionUnit"]
        >((params) => {
          turns += 1;
          expect(
            params.tools?.some((tool) => tool.function.name === toolId)
          ).toBe(true);
          return {
            stream: (async function* () {})(),
            final: Promise.resolve<import("@/ports").CompletionFinalResult>(
              turns === 1
                ? {
                    ok: true,
                    requestId: "test-completion",
                    usage: { promptTokens: 10, completionTokens: 5 },
                    toolCalls: [
                      {
                        id: "brain-writer-call",
                        type: "function",
                        function: {
                          name: toolId,
                          arguments: JSON.stringify({
                            id: "hypothesis-test",
                            domain: "strategy",
                            title: "Test prediction",
                            content: "The guarded call ends once.",
                            evaluateAt: "2026-12-01T00:00:00.000Z",
                            sourceType: "agent",
                          }),
                        },
                      },
                    ],
                    finishReason: "tool_calls",
                  }
                : {
                    ok: true,
                    requestId: "test-completion",
                    usage: { promptTokens: 10, completionTokens: 5 },
                    content: "Granted writer finished.",
                    finishReason: "stop",
                  }
            ),
          };
        }),
      };
      const provider = new LangGraphInProcProvider(
        adapter,
        {
          getBoundTool: (id) => (id === toolId ? runtime : undefined),
          listToolSpecs: () => [runtime.spec],
          hasToolId: (id) => id === toolId,
        },
        undefined,
        CORE_TOOL_BUNDLE,
        authorization,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        authority
      );
      await runInScope(
        {
          ...TEST_SCOPE,
          llmService: {
            completionStream: vi.fn(async () => {
              throw new Error("Scripted adapter owns inference");
            }),
          },
          principalId: "node-ai-user",
          subjectUserId: "requester",
          nodeId: "operator-node",
          runId: "test-run-id",
          runKind: "user_immediate",
        },
        async () => {
          const run = provider.runGraph(
            createTestRequest({ graphId: "langgraph:brain" })
          );
          const events: AiEvent[] = [];
          for await (const event of run.stream) events.push(event);
          const final = await run.final;
          expect(liveScopes).toHaveBeenCalledWith(
            "node-ai-user",
            expect.arrayContaining(["edo:write"])
          );
          expect(check).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              actorId: "agent:node-ai-user",
              subjectId: "user:requester",
              action: "tool.execute",
              resource: `tool:${toolId}`,
              context: expect.objectContaining({
                tenantId: "test-billing",
                runId: "test-run-id",
                graphId: "langgraph:brain",
                toolCallId: expect.any(String),
              }),
            })
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "tool_call_result",
              toolCallId: check.mock.calls[0]?.[0].context.toolCallId,
            })
          );
          expect(events.filter((event) => event.type === "done")).toHaveLength(
            1
          );
          expect(events.some((event) => event.type === "error")).toBe(
            decision !== "allow"
          );
          if (decision === "allow") {
            expect(final).toMatchObject({
              ok: true,
              content: "Granted writer finished.",
            });
            expect(writes).toHaveBeenCalledOnce();
            expect(writes).toHaveBeenCalledWith(
              expect.any(Object),
              expect.objectContaining({
                actorId: "agent:node-ai-user",
                subjectId: "user:requester",
              }),
              {}
            );
            expect(hasLiveRole).toHaveBeenCalledWith(
              "node-ai-user",
              "edo:write"
            );
            expect(adapter.executeCompletionUnit).toHaveBeenCalledTimes(2);
          } else {
            expect(final).toMatchObject({
              ok: false,
              error:
                decision === "deny" || decision === "field"
                  ? "policy_denied"
                  : "authz_unavailable",
              content: "Tool execution stopped by its authority check.",
              structuredOutput: {
                code:
                  decision === "deny" || decision === "field"
                    ? "policy_denied"
                    : "authz_unavailable",
                retryable: false,
                lookup: { tool: toolId, scope: "edo:write" },
              },
            });
            expect(writes).not.toHaveBeenCalled();
            if (decision === "field") expect(hasLiveRole).toHaveBeenCalled();
            else expect(hasLiveRole).not.toHaveBeenCalled();
            expect(adapter.executeCompletionUnit).toHaveBeenCalledOnce();
            expect(JSON.stringify({ final, events })).not.toContain(
              "private authority outage details"
            );
          }
        }
      );
    });
  });

  describe("program writer refusal before graph construction", () => {
    it.each([
      {
        graph: "cogni",
        unavailable: false,
        granted: false,
        code: "policy_denied",
      },
      {
        graph: "cogni",
        unavailable: true,
        granted: false,
        code: "authz_unavailable",
      },
      {
        graph: "work-prioritizer",
        unavailable: false,
        granted: false,
        code: "policy_denied",
      },
      {
        graph: "work-prioritizer",
        unavailable: true,
        granted: false,
        code: "authz_unavailable",
      },
      { graph: "cogni", unavailable: false, granted: true, code: undefined },
    ])("retains authority outcomes without unauthorized inference: %j", async ({
      graph,
      unavailable,
      granted,
      code,
    }) => {
      const adapter = createMockAdapter();
      const authority: GuardDeps = {
        withStore: async (fn) => {
          if (unavailable) throw new Error("store unavailable");
          return fn({
            liveScopes: async (_id, scopes) => (granted ? [...scopes] : []),
          } as AgentGrantsStore);
        },
        adminCheck: async () => "denied",
      };
      const provider = new LangGraphInProcProvider(
        adapter,
        createMockToolSource(),
        undefined,
        CORE_TOOL_BUNDLE,
        undefined,
        "operator-node",
        "https://test.cognidao.org",
        {
          content: "Serve this node.",
          sourceRef: "test:mission",
          buildSha: null,
        },
        undefined,
        undefined,
        undefined,
        authority
      );
      await runInScope(
        { ...TEST_SCOPE, principalId: "node-ai-user" },
        async () => {
          const result = provider.runGraph(
            createTestRequest({ graphId: `langgraph:${graph}` })
          );
          const events: AiEvent[] = [];
          for await (const event of result.stream) events.push(event);
          if (granted) {
            expect(await result.final).toMatchObject({ ok: true });
            expect(adapter.executeCompletionUnit).toHaveBeenCalled();
            return;
          }
          expect(await result.final).toMatchObject({
            ok: false,
            error: code,
            structuredOutput: {
              code,
              retryable: false,
              lookup: { tool: "core__edo_decide", scope: "edo:write" },
            },
          });
          expect(events.some((event) => event.type === "error")).toBe(true);
          expect(events.at(-1)).toEqual({ type: "done" });
          expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
        }
      );
    });
  });

  describe("valid graphId", () => {
    it("calls adapter.executeCompletionUnit and emits events reflecting adapter stream", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const adapterEvents: AiEvent[] = [
          { type: "text_delta", delta: "Hello " },
          { type: "text_delta", delta: "World" },
        ];
        const mockAdapter = createMockAdapter({ events: adapterEvents });
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        const request = createTestRequest({ graphId: "langgraph:poet" });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Adapter should be called
        expect(mockAdapter.executeCompletionUnit).toHaveBeenCalled();

        // Events should flow from adapter through runner
        // Note: runner adds assistant_final and done
        const textDeltas = events.filter((e) => e.type === "text_delta");
        expect(textDeltas.length).toBeGreaterThan(0);

        // Terminal events present
        const assistantFinals = events.filter(
          (e) => e.type === "assistant_final"
        );
        const dones = events.filter((e) => e.type === "done");
        expect(assistantFinals).toHaveLength(1);
        expect(dones).toHaveLength(1);

        // done is last
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects success
        expect(result.ok).toBe(true);
      });
    });
  });

  describe("authz v0 identity threading", () => {
    it("passes the scope's nodeId and grantId (and the actor) to the tool runner", async () => {
      toolRunnerSpy.calls.length = 0;
      const scope = {
        ...TEST_SCOPE,
        actorUserId: "00000000-0000-4000-a000-000000000001",
        subjectUserId: "00000000-0000-4000-a000-000000000001",
        principalId: "catalog-agent",
        nodeId: "operator-node-id",
        grantId: "grant-123",
      };
      await runInScope(scope, async () => {
        const provider = new LangGraphInProcProvider(
          createMockAdapter(),
          createMockToolSource(),
          undefined,
          [],
          new FakeAuthorizationAdapter()
        );
        const { stream, final } = provider.runGraph(
          createTestRequest({ graphId: "langgraph:poet" })
        );
        for await (const _ of stream) {
          // drain
        }
        await final;
      });

      expect(toolRunnerSpy.calls.length).toBeGreaterThan(0);
      const config = toolRunnerSpy.calls[0]?.[2] as Record<string, unknown>;
      expect(config).toMatchObject({
        nodeId: "operator-node-id",
        grantId: "grant-123",
        actorId: "agent:catalog-agent",
        subjectId: "user:00000000-0000-4000-a000-000000000001",
        graphId: "langgraph:poet",
      });
      expect(typeof config.onAuthzDecision).toBe("function");
    });

    it("omits grantId for API/chat runs (no grant in scope)", async () => {
      toolRunnerSpy.calls.length = 0;
      await runInScope(
        {
          ...TEST_SCOPE,
          principalId: "catalog-agent",
          actorUserId: "user-1",
          subjectUserId: "user-1",
          nodeId: "operator-node-id",
        },
        async () => {
          const provider = new LangGraphInProcProvider(
            createMockAdapter(),
            createMockToolSource()
          );
          const { stream, final } = provider.runGraph(createTestRequest());
          for await (const _ of stream) {
            // drain
          }
          await final;
        }
      );
      const config = toolRunnerSpy.calls[0]?.[2] as Record<string, unknown>;
      expect(config.nodeId).toBe("operator-node-id");
      expect(config).not.toHaveProperty("grantId");
    });

    it("propagates trusted identity + audit hook WITHOUT an authz adapter (declared policies still apply)", async () => {
      toolRunnerSpy.calls.length = 0;
      await runInScope(
        {
          ...TEST_SCOPE,
          actorUserId: "00000000-0000-4000-a000-000000000001",
          subjectUserId: "00000000-0000-4000-a000-000000000001",
          principalId: "catalog-agent",
          nodeId: "operator-node-id",
          grantId: "grant-123",
        },
        async () => {
          const provider = new LangGraphInProcProvider(
            createMockAdapter(),
            createMockToolSource()
          );
          const { stream, final } = provider.runGraph(createTestRequest());
          for await (const _ of stream) {
            // drain
          }
          await final;
        }
      );
      const config = toolRunnerSpy.calls[0]?.[2] as Record<string, unknown>;
      expect(config).toMatchObject({
        actorId: "agent:catalog-agent",
        subjectId: "user:00000000-0000-4000-a000-000000000001",
        tenantId: "test-billing",
        graphId: "langgraph:poet",
        nodeId: "operator-node-id",
        grantId: "grant-123",
      });
      expect(typeof config.onAuthzDecision).toBe("function");
      expect(config).not.toHaveProperty("authz");
    });
  });

  describe("catalog principal reaches the outer runner (story.0085)", () => {
    const principalId = "operating-review-user";
    const nodeId = "operator-node-id";
    const readId = "core__goal_list";
    const writeId = "core__work_item_update";

    async function launch(
      options: {
        graph?: string;
        subjectUserId?: string;
        principal?: string;
        granted?: boolean;
        privileged?: boolean;
        unavailable?: boolean;
      } = {}
    ) {
      toolRunnerSpy.runners.length = 0;
      const writes = vi.fn(async (_args: unknown, ctx: unknown) => ({ ctx }));
      const reads = vi.fn(async () => ({ goals: [] }));
      const runtime = (
        id: string,
        exec: BoundToolRuntime["exec"],
        effect: BoundToolRuntime["effect"]
      ): BoundToolRuntime => ({
        id,
        spec: {
          name: id,
          description: "authorization fixture",
          inputSchema: { type: "object" },
        },
        effect,
        requires: options.privileged ? "node.flight" : "node.collaborate",
        requiresConnection: false,
        capabilities: [],
        validateInput: (v) => v,
        validateOutput: (v) => v,
        redact: (v) => v,
        exec,
      });
      const source = new Map([
        [readId, runtime(readId, reads, "read_only")],
        [writeId, runtime(writeId, writes, "state_change")],
        [
          "core__edo_decide",
          runtime("core__edo_decide", writes, "state_change"),
        ],
      ]);
      const granted = options.granted ?? true;
      const liveScopes = vi.fn(async (id: string, scopes: readonly string[]) =>
        granted && id === principalId ? [...scopes] : []
      );
      const hasLiveRole = vi.fn(
        async (id: string) => granted && id === principalId
      );
      const store = { liveScopes, hasLiveRole } as unknown as AgentGrantsStore;
      const adminCheck = vi.fn(async () => "allow" as const);
      const authority: GuardDeps = {
        withStore: async (fn) => {
          if (options.unavailable) throw new Error("authority unavailable");
          return fn(store);
        },
        adminCheck,
      };
      const authorization = new FakeAuthorizationAdapter();
      const check = vi.spyOn(authorization, "check");
      const scope = {
        ...TEST_SCOPE,
        ...(options.principal ? { principalId: options.principal } : {}),
        ...(options.subjectUserId
          ? {
              subjectUserId: options.subjectUserId,
              actorUserId: options.subjectUserId,
            }
          : {}),
        runId: "test-run-id",
        runKind: "system_scheduled" as const,
        nodeId,
      };
      const provider = new LangGraphInProcProvider(
        createMockAdapter(),
        {
          getBoundTool: (id) => source.get(id),
          listToolSpecs: () => [...source.values()].map((r) => r.spec),
          hasToolId: (id) => source.has(id),
        },
        undefined,
        [],
        authorization,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        authority
      );
      await runInScope(scope, async () => {
        const result = provider.runGraph(
          createTestRequest({
            graphId: `langgraph:${options.graph ?? "operating-review"}`,
          })
        );
        for await (const _ of result.stream) {
          /* drain */
        }
        await result.final;
      });
      const runner = toolRunnerSpy.runners[0];
      if (!runner) throw new Error("provider did not create a tool runner");
      return {
        writes,
        reads,
        check,
        liveScopes,
        hasLiveRole,
        adminCheck,
        exec: (id: string, args: unknown = {}) =>
          runInScope(scope, () => runner.exec(id, args)),
      };
    }

    it.each([
      "cogni",
      "brain",
      "autoresearch-single-lane",
      "autoresearch-syntropy-loop",
      "autoresearch-registry-swarm",
    ])("subjectless %s executes EDO writes beyond the outer gate", async (graph) => {
      const run = await launch({ graph, principal: principalId });
      if (graph === "cogni") {
        expect(await run.exec(readId)).toMatchObject({ ok: true });
        expect(run.reads).toHaveBeenCalledOnce();
      }
      expect(await run.exec("core__edo_decide")).toMatchObject({ ok: true });
      expect(run.writes).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ actorId: `agent:${principalId}` }),
        {}
      );
      expect(run.writes.mock.calls[0]?.[1]).not.toHaveProperty("subjectId");
      expect(run.hasLiveRole).toHaveBeenCalledWith(principalId, "edo:write");
    });

    it("Operating Review retains its own catalog identity and executes a triage patch with a separate requester", async () => {
      expect(LANGGRAPH_CATALOG["operating-review"]?.principal).toBe(
        "operating-review"
      );
      const run = await launch({
        principal: principalId,
        subjectUserId: "requester",
      });
      const patch = {
        id: "task.1",
        expectedRevision: 4,
        reason: "Triage",
        set: { priority: 2, status: "needs_design" },
      };
      expect(await run.exec(writeId, patch)).toMatchObject({ ok: true });
      expect(run.writes).toHaveBeenCalledWith(
        patch,
        expect.objectContaining({
          actorId: `agent:${principalId}`,
          subjectId: "user:requester",
        }),
        {}
      );
      expect(run.hasLiveRole).toHaveBeenCalledWith(
        principalId,
        "work_item:transition"
      );
      const prompt = LANGGRAPH_CATALOG["operating-review"]?.systemPrompt;
      expect(prompt).toContain("set:{priority, status}");
      expect(prompt).not.toContain("Status writes are unavailable");
      expect(prompt).toContain("gate_unmet");
    });

    it("an authenticated requester never substitutes for a missing principal", async () => {
      const run = await launch({ subjectUserId: "requester" });
      expect(await run.exec(writeId)).toMatchObject({ ok: false });
      expect(run.writes).not.toHaveBeenCalled();
      const config = toolRunnerSpy.calls.at(-1)?.[2] as Record<string, unknown>;
      expect(config).not.toHaveProperty("actorId");
      expect(config.subjectId).toBe("user:requester");
    });

    it.each([
      { granted: false },
      { unavailable: true },
    ])("missing or unavailable principal grants withhold writers: %j", async (options) => {
      const run = await launch({ principal: principalId, ...options });
      expect(await run.exec(writeId)).toMatchObject({ ok: false });
      expect(run.writes).not.toHaveBeenCalled();
    });

    it("revocation after offering a writer refuses before mutation", async () => {
      const run = await launch({
        graph: "cogni",
        principal: principalId,
        subjectUserId: "requester",
      });
      run.hasLiveRole.mockResolvedValue(false);
      expect(await run.exec("core__edo_decide")).toMatchObject({ ok: false });
      expect(run.writes).not.toHaveBeenCalled();
    });

    it("genuine operator actions still require OpenFGA permission", async () => {
      const run = await launch({
        graph: "cogni",
        principal: principalId,
        privileged: true,
      });
      expect(await run.exec(readId)).toMatchObject({
        ok: false,
        errorCode: "authz_denied",
      });
      expect(run.check).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: `user:${principalId}`,
          action: "node.flight",
          resource: `node:${nodeId}`,
        })
      );
      expect(run.reads).not.toHaveBeenCalled();
    });
  });

  describe("host architect selection (task.5455)", () => {
    const row = (id: string) => ({ id });

    it("picks the one -architect entry in the index", () => {
      expect(
        selectArchitectEntryId([
          row("no-secrets-in-logs"),
          row("operator-architect"),
        ])
      ).toBe("operator-architect");
    });

    it("skips when none, or when several and no slug is known", () => {
      expect(selectArchitectEntryId([row("a-rule")])).toBeNull();
      expect(
        selectArchitectEntryId([
          row("operator-architect"),
          row("node-template-architect"),
        ])
      ).toBeNull();
    });

    it("prefers the slug-named architect when several exist and the slug matches", () => {
      const index = [row("operator-architect"), row("node-template-architect")];
      expect(selectArchitectEntryId(index, "operator")).toBe(
        "operator-architect"
      );
      expect(selectArchitectEntryId(index, "poly")).toBeNull();
    });

    it("the pr-review catalog entry opts in; other graphs do not", () => {
      expect(LANGGRAPH_CATALOG["pr-review"]?.hostArchitect).toBe(true);
      expect(LANGGRAPH_CATALOG.poet?.hostArchitect).toBeUndefined();
    });
  });

  describe("catalog report seam (CatalogEntry.report)", () => {
    const report = { event: "ai.work_prioritizer.cycle" };

    it("every catalog-declared report names a registered event", () => {
      const registered = new Set<string>(Object.values(EVENT_NAMES));
      const declared = Object.values(LANGGRAPH_CATALOG).flatMap((e) => {
        const r = (e as { report?: { event: string } }).report;
        return r ? [r.event] : [];
      });
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(registered.has(name)).toBe(true);
    });

    it("logs the telemetry as one `event`", () => {
      expect(
        graphReportLogFields(report, "run-9", {
          telemetry: { changedItemIds: ["task.1"], changeCount: 1 },
        })
      ).toEqual([
        {
          event: "ai.work_prioritizer.cycle",
          runId: "run-9",
          changedItemIds: ["task.1"],
          changeCount: 1,
        },
      ]);
    });

    it("emits nothing when the output carries no report", () => {
      expect(graphReportLogFields(report, "r", undefined)).toEqual([]);
      expect(graphReportLogFields(report, "r", { content: "x" })).toEqual([]);
      expect(graphReportDelta({ content: "x" })).toBeNull();
    });

    it("echoes the telemetry as one <graph_report> delta", () => {
      expect(graphReportDelta({ telemetry: { changeCount: 0 } })).toBe(
        '\n<graph_report>{"changeCount":0}</graph_report>\n'
      );
    });
  });

  describe("review subject (task.5448)", () => {
    const OPERATOR_NODE = "operator-node-id";
    const OTHER_NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
    const subjectOf = (nodeId: string) => ({
      nodeId,
      owner: "cogni-dao",
      repo: "node-template",
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
    });
    const grounding = {
      nodeId: OTHER_NODE,
      origin: "https://node-template.test",
      mission: {
        content: "SUBJECT MISSION TEXT",
        sourceRef: "cogni-dao/node-template@bbbbbbbbbbbb:.cogni/repo-spec.yaml",
        buildSha: null,
      },
      governingIndex: [
        {
          id: "subject-rule",
          domain: "method",
          entryType: "rule",
          useWhen: "always",
        },
      ],
    };

    function build(opts: {
      loader?: ConstructorParameters<typeof LangGraphInProcProvider>[10];
    }) {
      const adapter = createMockAdapter({
        finalResult: { ok: true, requestId: "r", finishReason: "stop" },
      });
      const governingIndexReader = vi.fn(async () => [
        {
          id: "operator-rule",
          domain: "method",
          entryType: "rule",
          useWhen: "operator only",
        },
      ]);
      const architectRead = vi.fn(async () => "OPERATOR ARCHITECT");
      const provider = new LangGraphInProcProvider(
        adapter,
        createMockToolSource(),
        undefined,
        [...CORE_TOOL_BUNDLE],
        new FakeAuthorizationAdapter(),
        OPERATOR_NODE,
        "https://operator.test",
        {
          content: "OPERATOR MISSION TEXT",
          sourceRef: "operator",
          buildSha: null,
        },
        governingIndexReader,
        { read: architectRead },
        opts.loader
      );
      return { adapter, provider, governingIndexReader, architectRead };
    }

    async function run(
      provider: LangGraphInProcProvider,
      subject: ReturnType<typeof subjectOf>
    ) {
      toolRunnerSpy.calls.length = 0;
      return runInScope(
        {
          ...TEST_SCOPE,
          actorUserId: "00000000-0000-4000-a000-000000000001",
          subjectUserId: "00000000-0000-4000-a000-000000000001",
          principalId: "catalog-agent",
          nodeId: OPERATOR_NODE,
          codeSubject: subject,
        },
        async () => {
          const { stream, final } = provider.runGraph(
            createTestRequest({ graphId: "langgraph:pr-review" })
          );
          const events: AiEvent[] = [];
          for await (const event of stream) events.push(event);
          return { events, result: await final };
        }
      );
    }

    it("another node: preamble comes from the loader, never the operator hub; no work_item_read; authority on the subject node", async () => {
      const loader = vi.fn(async () => grounding);
      const { adapter, provider, governingIndexReader, architectRead } = build({
        loader,
      });
      await run(provider, subjectOf(OTHER_NODE));

      expect(loader).toHaveBeenCalledWith(subjectOf(OTHER_NODE));
      expect(governingIndexReader).not.toHaveBeenCalled();
      expect(architectRead).not.toHaveBeenCalled();

      const call = (adapter.executeCompletionUnit as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as {
        messages: Array<{ content: unknown }>;
        tools?: unknown;
      };
      const prompt = JSON.stringify(call.messages);
      expect(prompt).toContain("SUBJECT MISSION TEXT");
      expect(prompt).toContain("subject-rule");
      expect(prompt).not.toContain("OPERATOR MISSION TEXT");
      expect(prompt).not.toContain("operator-rule");
      const tools = JSON.stringify(call.tools ?? []);
      expect(tools).toContain("core__knowledge_read");
      expect(tools).not.toContain("core__work_item_read");

      const config = toolRunnerSpy.calls[0]?.[2] as Record<string, unknown>;
      expect(config.nodeId).toBe(OTHER_NODE);
    });

    it("a refused read fails the run with its typed code BEFORE any model call", async () => {
      const loader = vi.fn(async () => {
        throw new AiExecutionError("remote_policy_denied");
      });
      const { adapter, provider } = build({ loader });
      const { events, result } = await run(provider, subjectOf(OTHER_NODE));
      expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === "error")).toEqual([
        { type: "error", error: "remote_policy_denied" },
      ]);
      expect(events[events.length - 1]).toEqual({ type: "done" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("remote_policy_denied");
    });

    it("another node without a grounding loader fails closed; there is no operator fallback", async () => {
      const { adapter, provider, governingIndexReader } = build({});
      const { result } = await run(provider, subjectOf(OTHER_NODE));
      expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
      expect(governingIndexReader).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.error).toBe("internal");
    });

    it("the operator's own subject is exactly today's local path", async () => {
      const loader = vi.fn(async () => grounding);
      const { adapter, provider, governingIndexReader, architectRead } = build({
        loader,
      });
      await run(provider, subjectOf(OPERATOR_NODE));

      expect(loader).not.toHaveBeenCalled();
      expect(governingIndexReader).toHaveBeenCalledTimes(1);
      expect(architectRead).not.toHaveBeenCalled(); // no `*-architect` entry in the operator index fixture
      const call = (adapter.executeCompletionUnit as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as { messages: unknown; tools?: unknown };
      const prompt = JSON.stringify(call.messages);
      expect(prompt).toContain("OPERATOR MISSION TEXT");
      expect(prompt).toContain("operator-rule");
      expect(JSON.stringify(call.tools ?? [])).toContain(
        "core__work_item_read"
      );
      const config = toolRunnerSpy.calls[0]?.[2] as Record<string, unknown>;
      expect(config.nodeId).toBe(OPERATOR_NODE);
    });
  });

  describe("invalid graphId", () => {
    it("emits not_found error then done for unknown graph (REQ1)", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const mockAdapter = createMockAdapter();
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        // Request with graph not in catalog
        const request = createTestRequest({
          graphId: "langgraph:nonexistent_graph",
        });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Should NOT call adapter
        expect(mockAdapter.executeCompletionUnit).not.toHaveBeenCalled();

        // Should emit error (client error, not 'internal')
        const errors = events.filter((e) => e.type === "error");
        expect(errors).toHaveLength(1);
        // Per REQ1: assert client error code, not 'internal'
        expect(errors[0]).toEqual({ type: "error", error: "not_found" });

        // done must be last
        const dones = events.filter((e) => e.type === "done");
        expect(dones).toHaveLength(1);
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects failure
        expect(result.ok).toBe(false);
        expect(result.error).toBe("not_found");
      });
    });

    it("emits invalid_request error for malformed graphId", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const mockAdapter = createMockAdapter();
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        // Request with wrong provider prefix
        const request = createTestRequest({
          graphId: "wrong_provider:poet",
        });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Should NOT call adapter
        expect(mockAdapter.executeCompletionUnit).not.toHaveBeenCalled();

        // Should emit error
        const errors = events.filter((e) => e.type === "error");
        expect(errors).toHaveLength(1);
        // Per REQ1: client error for malformed input
        expect(errors[0]).toEqual({ type: "error", error: "invalid_request" });

        // done must be last
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects failure
        expect(result.ok).toBe(false);
      });
    });
  });
});
