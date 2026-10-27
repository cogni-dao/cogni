// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/assemble-assistant-message`
 * Purpose: Unit tests for the shared AiEvent[] → UIMessage assembler.
 * Scope: Verifies deterministic message ID, terminal-only semantics, and tool part assembly.
 * Invariants: IDEMPOTENT_THREAD_PERSIST, TERMINAL_ONLY_PERSIST, SHARED_EVENT_ASSEMBLER
 * Side-effects: none
 * Links: nodes/operator/app/src/features/ai/services/assemble-assistant-message.ts
 * @internal
 */

import { createHash } from "node:crypto";
import type { AiEvent } from "@cogni/ai-core";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import {
  createInProcGraphRunner,
  OPERATOR_LANGGRAPH_CATALOG,
} from "@cogni/langgraph-graphs";
import { describe, expect, it } from "vitest";
import { assembleAssistantMessage } from "@/features/ai/services/assemble-assistant-message";
import { redactSecretsInMessages } from "@/features/ai/services/secrets-redaction";

const RUN_ID = "test-run-001";

describe("assembleAssistantMessage", () => {
  it("returns null when no assistant_final event (error run)", () => {
    const events: AiEvent[] = [
      { type: "text_delta", delta: "partial" },
      { type: "error", error: "internal" },
    ];
    expect(assembleAssistantMessage(RUN_ID, events)).toBeNull();
  });

  it("returns null for empty event list", () => {
    expect(assembleAssistantMessage(RUN_ID, [])).toBeNull();
  });

  it("assembles text-only message from assistant_final", () => {
    const events: AiEvent[] = [
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "assistant_final", content: "Hello world" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg).not.toBeNull();
    expect(msg?.id).toBe(`assistant-${RUN_ID}`);
    expect(msg?.role).toBe("assistant");
    expect(msg?.parts).toHaveLength(1);
    expect(msg?.parts[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("uses deterministic message ID from runId", () => {
    const events: AiEvent[] = [
      { type: "assistant_final", content: "test" },
      { type: "done" },
    ];
    const msg1 = assembleAssistantMessage("run-aaa", events);
    const msg2 = assembleAssistantMessage("run-aaa", events);
    expect(msg1?.id).toBe("assistant-run-aaa");
    expect(msg1?.id).toBe(msg2?.id);
  });

  it("assembles tool call parts", () => {
    const events: AiEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "search",
        args: { query: "test" },
      },
      {
        type: "tool_call_result",
        toolCallId: "tc-1",
        result: { hits: 3 },
      },
      { type: "assistant_final", content: "Found 3 results" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg).not.toBeNull();
    expect(msg?.parts).toHaveLength(2); // text + tool
    const toolPart = msg?.parts[1];
    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "tc-1",
      toolName: "search",
      state: "output-available",
      input: { query: "test" },
      output: { hits: 3 },
    });
  });

  it("handles tool_call_start without result (partial tool execution)", () => {
    const events: AiEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "search",
        args: {},
      },
      { type: "assistant_final", content: "Interrupted" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg?.parts).toHaveLength(2);
    const toolPart = msg?.parts[1];
    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "tc-1",
      state: "input-available",
    });
  });

  it("ignores tool_call_result without a matching start", () => {
    const events: AiEvent[] = [
      {
        type: "tool_call_result",
        toolCallId: "tc-orphan",
        result: { error: "Tool execution is not authorized" },
        isError: true,
      },
      { type: "assistant_final", content: "I cannot use that tool." },
      { type: "done" },
    ];

    const msg = assembleAssistantMessage(RUN_ID, events);

    expect(msg?.parts).toEqual([
      { type: "text", text: "I cannot use that tool." },
    ]);
  });

  it("ignores usage_report and status events", () => {
    const events: AiEvent[] = [
      { type: "status", phase: "thinking" },
      {
        type: "usage_report",
        fact: {
          runId: RUN_ID,
          model: "test",
          promptTokens: 10,
          completionTokens: 5,
          callId: "c-1",
        },
      },
      { type: "assistant_final", content: "result" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg?.parts).toHaveLength(1);
    expect(msg?.parts[0]).toEqual({ type: "text", text: "result" });
  });
  it("retains the complete Cogni terminal artifact through the API persistence assembler and redactor", async () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG.cogni;
    const guideBody = "Owning guide exact body";
    const buildSha = "a".repeat(40);
    let turn = 0;
    const runner = createInProcGraphRunner({
      createGraph: entry.graphFactory,
      program: entry.program,
      sourceContext: {
        nodeId: "fixture-node",
        origin: "https://fixture.invalid",
        mission: {
          content: "The exact configured mission statement",
          sourceRef: ".cogni/repo-spec.yaml#intent.mission",
          buildSha,
        },
      },
      toolContracts: CORE_TOOL_BUNDLE.filter((tool) =>
        (entry.toolIds as readonly string[]).includes(tool.contract.name)
      ).map((tool) => tool.contract),
      completionFn: () => ({
        stream: (async function* () {
          yield {
            type: "text_delta" as const,
            delta: "UNVALIDATED RAW MODEL TEXT",
          };
        })(),
        final: Promise.resolve(
          ++turn === 1
            ? {
                ok: true as const,
                content: "",
                toolCalls: [
                  {
                    id: "read-pending",
                    type: "function" as const,
                    function: {
                      name: "core__knowledge_contribution_read",
                      arguments: JSON.stringify({
                        mode: "read_diff",
                        contributionId: "contrib-pending",
                      }),
                    },
                  },
                ],
              }
            : {
                ok: true as const,
                content: JSON.stringify({
                  summary: "Proposed clarification for the owning guide",
                  items: [
                    {
                      kind: "knowledge",
                      operation: "refine",
                      target: "mission-loop-expert",
                      rationale: "Pending diff clarifies a measured ambiguity",
                      nextAction:
                        "Request the named reviewer to examine the proposed sentence",
                      goalIds: ["goal-one"],
                      sourceIds: [
                        "mission-loop-expert",
                        "contribution:contrib-pending:head-A",
                      ],
                      proposal:
                        "Clarify the source requirement; do not publish automatically",
                    },
                  ],
                }),
              }
        ),
      }),
      createToolExecFn: () => async (name, args) => {
        const input = args as Record<string, unknown>;
        if (name === "core__knowledge_read")
          return {
            ok: true,
            value: {
              mode: "get",
              entries: [
                {
                  id: input.id,
                  domain: "method",
                  content: guideBody,
                  sourceRef: `main:${input.id}`,
                },
              ],
              totalFound: 1,
            },
          };
        if (name === "core__goal_list")
          return {
            ok: true,
            value: {
              goals: [{ id: "goal-one", content: "Useful bounded reviews" }],
            },
          };
        if (name === "core__knowledge_contribution_read")
          return {
            ok: true,
            value:
              input.mode === "list_open"
                ? {
                    mode: "list_open",
                    nodeId: "fixture-node",
                    complete: true,
                    contributions: [
                      {
                        contributionId: "contrib-pending",
                        headCommit: "head-A",
                        principalKind: "agent",
                        principalId: "real-author",
                      },
                    ],
                  }
                : {
                    mode: "read_diff",
                    nodeId: "fixture-node",
                    complete: true,
                    contribution: {
                      contributionId: "contrib-pending",
                      headCommit: "head-A",
                      principalKind: "agent",
                      principalId: "real-author",
                    },
                    entries: [
                      {
                        changeType: "modified",
                        rowId: "mission-loop-expert",
                        before: { content: guideBody },
                        after: { content: "Proposed clarified guide" },
                      },
                    ],
                  },
          };
        throw new Error("Unexpected tool");
      },
      request: {
        runId: RUN_ID,
        messages: [
          { role: "user", content: "Review this knowledge refinement" },
        ],
        configurable: { model: "fixture-model", toolIds: [...entry.toolIds] },
      },
    });
    const events: AiEvent[] = [];
    for await (const event of runner.stream) events.push(event);
    const returned = await runner.final;
    expect(returned.ok).toBe(true);
    const assembled = assembleAssistantMessage(RUN_ID, events);
    expect(assembled).not.toBeNull();
    if (!assembled) throw new Error("Terminal message missing");
    const persistedMessages = redactSecretsInMessages([assembled]);
    const text = persistedMessages[0]?.parts.find(
      (part) => part.type === "text"
    );
    expect(text).toEqual({ type: "text", text: returned.content });
    if (text?.type !== "text") throw new Error("Persistable text missing");
    expect(text.text).not.toContain("UNVALIDATED RAW MODEL TEXT");
    const artifact = JSON.parse(
      text.text.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null"
    );
    expect(artifact).toEqual(returned.structuredOutput?.proposal);
    expect(artifact.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "node-mission",
          nodeId: "fixture-node",
          origin: "https://fixture.invalid",
          buildSha,
          content: "The exact configured mission statement",
        }),
        expect.objectContaining({
          id: "mission-loop-expert",
          sourceRef: "main:mission-loop-expert",
          sha256: createHash("sha256").update(guideBody).digest("hex"),
        }),
        expect.objectContaining({
          id: "contribution:contrib-pending:head-A",
          metadata: {
            contributionId: "contrib-pending",
            headCommit: "head-A",
            principalKind: "agent",
            principalId: "real-author",
          },
        }),
      ])
    );
  });
});
