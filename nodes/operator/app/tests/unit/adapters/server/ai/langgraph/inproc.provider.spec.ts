// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/inproc.provider`
 * Purpose: Wiring tests for LangGraphInProcProvider - adapter integration and error handling.
 * Scope: Verifies adapter.executeCompletionUnit is called correctly and events reflect adapter stream. Does NOT test actual graph execution or LLM calls.
 * Invariants:
 *   - Valid graphId: events reflect adapter stream
 *   - Invalid graphId: emits client error (not_found), done is last
 * Side-effects: none (all mocked)
 * Links: inproc.provider.ts, GRAPH_EXECUTION.md
 * @internal
 */

import type { AiEvent, ToolSourcePort } from "@cogni/ai-core";
import { TOOL_CATALOG, toBoundToolRuntime } from "@cogni/ai-tools";
import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { describe, expect, it, vi } from "vitest";

// Pass-through spy so the provider's tool-runner config can be asserted (authz v0).
const toolRunnerSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@cogni/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/ai-core")>();
  return {
    ...actual,
    createToolRunner: (...args: Parameters<typeof actual.createToolRunner>) => {
      toolRunnerSpy.calls.push(args);
      return actual.createToolRunner(...args);
    },
  };
});

// Pass-through spy on the package runner so the graph's RunnableConfig.configurable can be asserted.
const runnerSpy = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cogni/langgraph-graphs")>();
  return {
    ...actual,
    createInProcGraphRunner: (
      ...args: Parameters<typeof actual.createInProcGraphRunner>
    ) => {
      runnerSpy.calls.push(args[0]);
      return actual.createInProcGraphRunner(...args);
    },
  };
});

import { runInScope } from "@/adapters/server/ai/execution-scope";
import type { CompletionUnitAdapter } from "@/adapters/server/ai/langgraph/inproc.provider";
import {
  graphReportDelta,
  graphReportLogFields,
  LangGraphInProcProvider,
} from "@/adapters/server/ai/langgraph/inproc.provider";
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
        actorId: "user:00000000-0000-4000-a000-000000000001",
        graphId: "langgraph:poet",
      });
      expect(typeof config.onAuthzDecision).toBe("function");
    });

    it("omits grantId for API/chat runs (no grant in scope)", async () => {
      toolRunnerSpy.calls.length = 0;
      await runInScope(
        { ...TEST_SCOPE, actorUserId: "user-1", nodeId: "operator-node-id" },
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
        actorId: "user:00000000-0000-4000-a000-000000000001",
        tenantId: "test-billing",
        graphId: "langgraph:poet",
        nodeId: "operator-node-id",
        grantId: "grant-123",
      });
      expect(typeof config.onAuthzDecision).toBe("function");
      expect(config).not.toHaveProperty("authz");
    });
  });

  describe("scheduled apply switch (story.5108)", () => {
    async function configurableOf(
      scope: Record<string, unknown>,
      resolve: (graphId: string) => boolean
    ) {
      runnerSpy.calls.length = 0;
      await runInScope({ ...TEST_SCOPE, ...scope }, async () => {
        const provider = new LangGraphInProcProvider(
          createMockAdapter(),
          createMockToolSource(),
          undefined,
          [],
          undefined,
          resolve
        );
        const { stream, final } = provider.runGraph(createTestRequest());
        for await (const _ of stream) {
          // drain
        }
        await final;
      });
      return (
        runnerSpy.calls[0] as {
          request: { configurable: Record<string, unknown> };
        }
      ).request.configurable;
    }

    it("a grant-backed run carries apply: true when the graph's schedule allows it", async () => {
      const resolve = vi.fn(() => true);
      const configurable = await configurableOf(
        { actorUserId: "user-1", grantId: "grant-123" },
        resolve
      );
      expect(resolve).toHaveBeenCalledWith("langgraph:poet");
      expect(configurable).toMatchObject({ grantId: "grant-123", apply: true });
    });

    it("a grant-backed run whose schedule says no carries no apply", async () => {
      const configurable = await configurableOf(
        { actorUserId: "user-1", grantId: "grant-123" },
        () => false
      );
      expect(configurable).not.toHaveProperty("apply");
    });

    it("an API/chat run (no grant) never carries apply and never asks the resolver", async () => {
      const resolve = vi.fn(() => true);
      const configurable = await configurableOf(
        { actorUserId: "user-1" },
        resolve
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(configurable).not.toHaveProperty("apply");
    });
  });

  describe("catalog report seam (CatalogEntry.report)", () => {
    const report = {
      event: "ai.work_prioritizer.cycle",
      sampleEvent: "ai.work_prioritizer.judge_sample",
    };

    it("every catalog-declared report names registered events", () => {
      const registered = new Set<string>(Object.values(EVENT_NAMES));
      const declared = Object.values(LANGGRAPH_CATALOG).flatMap((e) => {
        const r = (e as { report?: { event: string; sampleEvent?: string } })
          .report;
        return r ? [r.event, ...(r.sampleEvent ? [r.sampleEvent] : [])] : [];
      });
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(registered.has(name)).toBe(true);
    });

    it("logs the telemetry as `event` and each sample as `sampleEvent`", () => {
      const sample = {
        lines: ['{"id":"bug.1","harmDays":"1 day"}'],
        counts: { lines: 14, parsed: 14, withHarm: 3, withHarmDays: 1 },
      };
      expect(
        graphReportLogFields(report, "run-9", {
          telemetry: { status: "planned", decisionId: "d", edoWrites: 1 },
          samples: [sample],
        })
      ).toEqual([
        {
          event: "ai.work_prioritizer.cycle",
          runId: "run-9",
          status: "planned",
          decisionId: "d",
          edoWrites: 1,
        },
        {
          event: "ai.work_prioritizer.judge_sample",
          runId: "run-9",
          batch: 0,
          ...sample,
        },
      ]);
    });

    it("emits nothing when the output carries no report", () => {
      expect(graphReportLogFields(report, "r", undefined)).toEqual([]);
      expect(graphReportLogFields(report, "r", { content: "x" })).toEqual([]);
      expect(graphReportDelta({ content: "x" })).toBeNull();
    });

    it("echoes the telemetry as one <graph_report> delta", () => {
      expect(graphReportDelta({ telemetry: { status: "no_change" } })).toBe(
        '\n<graph_report>{"status":"no_change"}</graph_report>\n'
      );
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
