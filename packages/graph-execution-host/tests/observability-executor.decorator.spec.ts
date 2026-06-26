// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/tests/observability-executor.decorator.spec`
 * Purpose: Unit tests for ObservabilityGraphExecutorDecorator node attribution.
 * Scope: Tests LANGFUSE_NODE_ATTRIBUTION — nodeId stamped on trace tags + metadata. Does not test Langfuse SDK or terminal-state matrix.
 * Invariants:
 *   - LANGFUSE_NODE_ATTRIBUTION: nodeId on every trace (tag + metadata) when wired; omitted (not null) when absent
 * Side-effects: none (in-memory spies only)
 * Links: src/decorators/observability-executor.decorator.ts, docs/spec/observability.md#langfuse-integration
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import type {
  GraphExecutorPort,
  GraphRunRequest,
} from "@cogni/graph-execution-core";
import { describe, expect, it } from "vitest";

import { ObservabilityGraphExecutorDecorator } from "../src/decorators/observability-executor.decorator";
import type { LoggerPort } from "../src/ports/logger.port";
import type {
  CreateTraceWithIOParams,
  TracingPort,
} from "../src/ports/tracing.port";

const VALID_TRACE_ID = "abcdef0123456789abcdef0123456789";
const NODE_ID = "11111111-2222-3333-4444-555555555555";

function makeRequest(overrides?: Partial<GraphRunRequest>): GraphRunRequest {
  return {
    runId: "run-1",
    graphId: "langgraph:test",
    messages: [],
    modelRef: { providerKey: "platform", modelId: "gpt-4o" },
    ...overrides,
  };
}

/** Inner executor that streams a clean success terminal (done + ok final). */
function makeInnerExecutor(): GraphExecutorPort {
  const events: AiEvent[] = [
    { type: "text_delta", delta: "hi" },
    { type: "done" },
  ];
  return {
    runGraph: () => ({
      stream: (async function* () {
        for (const e of events) yield e;
      })(),
      final: Promise.resolve({
        ok: true,
        runId: "run-1",
        requestId: "run-1",
        content: "hi",
      }),
    }),
  };
}

class SpyTracingPort implements TracingPort {
  readonly traces: CreateTraceWithIOParams[] = [];
  createTraceWithIO(params: CreateTraceWithIOParams): string {
    this.traces.push(params);
    return params.traceId;
  }
  updateTraceOutput(): void {}
  async flush(): Promise<void> {}
}

const noopLog: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLog,
};

/** Run the decorator to completion (drain stream, await final so the terminal timer clears). */
async function run(decorator: GraphExecutorPort): Promise<void> {
  const result = decorator.runGraph(makeRequest());
  const drained: AiEvent[] = [];
  for await (const e of result.stream) drained.push(e);
  await result.final;
}

describe("ObservabilityGraphExecutorDecorator — LANGFUSE_NODE_ATTRIBUTION", () => {
  it("stamps nodeId on trace tags AND metadata when wired", async () => {
    const tracing = new SpyTracingPort();
    const decorator = new ObservabilityGraphExecutorDecorator(
      makeInnerExecutor(),
      tracing,
      { getTraceId: () => VALID_TRACE_ID, nodeId: NODE_ID },
      noopLog,
      "ba-1"
    );

    await run(decorator);

    expect(tracing.traces).toHaveLength(1);
    const trace = tracing.traces[0];
    // providerId ("langgraph") + graphId ("langgraph:test") + nodeId
    expect(trace?.tags).toEqual(["langgraph", "langgraph:test", NODE_ID]);
    expect(trace?.metadata.nodeId).toBe(NODE_ID);
    // billingAccountId stays alongside (no regression to the existing precedent)
    expect(trace?.metadata.billingAccountId).toBe("ba-1");
  });

  it("omits node attribution (not null) when nodeId is unwired", async () => {
    const tracing = new SpyTracingPort();
    const decorator = new ObservabilityGraphExecutorDecorator(
      makeInnerExecutor(),
      tracing,
      { getTraceId: () => VALID_TRACE_ID },
      noopLog,
      "ba-1"
    );

    await run(decorator);

    expect(tracing.traces).toHaveLength(1);
    const trace = tracing.traces[0];
    expect(trace?.tags).toEqual(["langgraph", "langgraph:test"]);
    expect(trace?.metadata).not.toHaveProperty("nodeId");
  });
});
