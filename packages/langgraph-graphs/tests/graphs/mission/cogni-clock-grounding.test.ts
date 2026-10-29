// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/mission/cogni-clock-grounding`
 * Purpose: The cogni engine grounds the real UTC clock in its host-owned preamble so a dated decision id uses the true year instead of a model-guessed one.
 * Scope: One run through the real in-proc runner capturing the system preamble; does not call a real LLM, hub, or clock service.
 * Invariants:
 *   - HOST_OWNED_CLOCK: the preamble carries the current UTC year, never a model-inferred date (regression: a `cogni-2023…` id filed in 2026)
 * Side-effects: none
 * Links: src/graphs/mission/cogni.ts (buildPreamble)
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { edoDecideContract, goalListContract } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import { COGNI_TOOL_IDS } from "../../../src/graphs/mission/cogni";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

const noopExec: (emit: (e: AiEvent) => void) => ToolExecFn =
  () => async () => ({ ok: true, value: {} });

describe("cogni engine host-owned clock grounding", () => {
  it("HOST_OWNED_CLOCK: the host preamble carries the real current UTC year, not a guessed date", async () => {
    const seen: string[] = [];
    const completionFn: CompletionFn = (req) => {
      seen.push(JSON.stringify(req.messages));
      return {
        stream: (async function* () {})(),
        final: Promise.resolve({
          ok: true as const,
          content: "No goals this run.",
          finishReason: "stop" as const,
        }),
      };
    };

    const { stream, final } = createInProcGraphRunner({
      program: "work-review",
      sourceContext: {
        nodeId: "test-node",
        origin: "https://test.example",
        mission: {
          content: "Test mission.",
          sourceRef: "test:mission",
          buildSha: null,
        },
      },
      createGraph: createMissionGraph,
      completionFn,
      createToolExecFn: noopExec,
      toolContracts: [goalListContract, edoDecideContract],
      request: {
        runId: "clock-1",
        messages: [{ role: "user", content: "what's our top priority?" }],
        configurable: { model: "test-model", toolIds: [...COGNI_TOOL_IDS] },
      },
    });
    for await (const _ of stream) {
      // drain
    }
    await final;

    const preamble = seen.join("\n");
    const year = new Date().getUTCFullYear().toString();
    expect(preamble).toContain("Host-owned current UTC time");
    expect(preamble).toContain(year);
    // The model's training-prior year must not be the one the host hands it.
    expect(year).not.toBe("2023");
  });
});
