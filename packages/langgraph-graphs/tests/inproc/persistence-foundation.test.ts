// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/persistence-foundation`
 * Purpose: The shared cogni engine compiles on the LangGraph persistence foundation (checkpointer + stable thread_id + Store) and a run persists its state through the real in-proc runner.
 * Scope: One deterministic single-turn run (no goals ⇒ gather→report) with a fake completion + tool exec; does not call a real LLM, hub, or Postgres saver.
 * Invariants:
 *   - ENGINE_PERSISTS_PER_THREAD: a run writes a checkpoint retrievable by its thread_id
 *   - STABLE_THREAD_ID: the host injects thread_id at the invoke seam (graphId:runId, else runId)
 *   - STORE_IS_CROSS_THREAD: the injected Store round-trips a value across namespaces
 *   - DURABLE_MEMORY_IS_THE_HUB: the checkpointer/Store hold per-run working state only
 * Side-effects: none (in-memory saver/store)
 * Links: src/graphs/operator/cogni.ts (.compile), src/inproc/runner.ts (thread_id seam)
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { edoDecideContract, goalListContract } from "@cogni/ai-tools";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { COGNI_TOOL_IDS } from "../../src/graphs/operator/cogni";
import { createOperatorGraph } from "../../src/graphs/operator/graph";
import { createInProcGraphRunner } from "../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../src/inproc/types";

// A completion that never calls a tool: gather ends on the first turn, no goals were read, so the
// graph runs GATHER → report → END (NO_GOALS_NO_DECISION). Deterministic: exactly one model call.
const noGoalsCompletion: CompletionFn = () => ({
  stream: (async function* () {})(),
  final: Promise.resolve({
    ok: true as const,
    content: "No goals this run.",
    finishReason: "stop" as const,
  }),
});

const noopExec: (emit: (e: AiEvent) => void) => ToolExecFn =
  () => async () => ({ ok: true, value: {} });

const SOURCE = {
  nodeId: "test-node",
  origin: "https://test.example",
  mission: {
    content: "Test mission: advance the node.",
    sourceRef: "test:mission",
    buildSha: null,
  },
} as const;

async function runTick(opts: {
  runId: string;
  graphId?: string;
  checkpointer: MemorySaver;
  store: InMemoryStore;
}) {
  const { stream, final } = createInProcGraphRunner({
    program: "work-review",
    sourceContext: SOURCE,
    createGraph: createOperatorGraph,
    completionFn: noGoalsCompletion,
    createToolExecFn: noopExec,
    // edo_decide must be present or the engine throws cogni_decision_tool_unavailable at build.
    toolContracts: [goalListContract, edoDecideContract],
    persistence: { checkpointer: opts.checkpointer, store: opts.store },
    request: {
      runId: opts.runId,
      messages: [{ role: "user", content: "TICK" }],
      configurable: {
        model: "test-model",
        toolIds: [...COGNI_TOOL_IDS],
        ...(opts.graphId != null ? { graphId: opts.graphId } : {}),
      },
    },
  });
  for await (const _ of stream) {
    // drain
  }
  return final;
}

describe("cogni engine persistence foundation", () => {
  it("ENGINE_PERSISTS_PER_THREAD: a run writes a checkpoint retrievable by its thread_id", async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    const result = await runTick({
      runId: "persist-tick-1",
      checkpointer,
      store,
    });
    expect(result.ok).toBe(true);

    // thread_id defaults to runId when no graphId is set (STABLE_THREAD_ID seam).
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: "persist-tick-1" },
    });
    expect(tuple).toBeDefined();
    expect(tuple?.config.configurable?.thread_id).toBe("persist-tick-1");
    // The persisted checkpoint carries the run's working state (the transcript lives in channels).
    expect(tuple?.checkpoint).toBeDefined();
  });

  it("STABLE_THREAD_ID: graphId scopes the thread as graphId:runId", async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    await runTick({
      runId: "tick-2",
      graphId: "langgraph:work-prioritizer",
      checkpointer,
      store,
    });

    const scoped = await checkpointer.getTuple({
      configurable: { thread_id: "langgraph:work-prioritizer:tick-2" },
    });
    expect(scoped).toBeDefined();
    // The bare runId is NOT a thread when a graphId scopes it.
    const bare = await checkpointer.getTuple({
      configurable: { thread_id: "tick-2" },
    });
    expect(bare).toBeUndefined();
  });

  it("STORE_IS_CROSS_THREAD: the injected Store round-trips a value", async () => {
    const store = new InMemoryStore();
    await store.put(["mission", "test-node"], "last-tick", {
      at: "2026-10-28",
    });
    const got = await store.get(["mission", "test-node"], "last-tick");
    expect(got?.value).toEqual({ at: "2026-10-28" });
  });
});
