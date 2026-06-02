// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/transcript/dev-session-map.spec`
 * Purpose: Unit tests for the Claude Code transcript → DevSessionDraft mapper —
 *   the parsing/scrubbing/capping core that turns the raw JSONL firehose into a
 *   navigable per-turn view. Proves it tolerates the evolving JSONL shape and
 *   never leaks secrets or unbounded payloads.
 * Scope: Pure mapper only. No Langfuse, no IO.
 * Invariants: SCRUB_BEFORE_SHAPE, VIEW_NOT_STORE, TOTAL_FUNCTION.
 * Side-effects: none
 * Links: src/shared/transcript/dev-session-map.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  DEV_SESSION_SOURCE,
  MAX_TURN_TEXT_BYTES,
  MAX_TURNS,
  mapTranscriptToDevSession,
  scrubSecrets,
} from "@/shared/transcript/dev-session-map";
import type { DevSessionMeta } from "@/types/dev-session";

const META: DevSessionMeta = {
  sessionId: "sess-abc",
  principalId: "user-1",
  principalName: "derek-claude",
  node: "operator",
  repo: "git@github.com:Cogni-DAO/node-template.git",
  headSha: "deadbeef",
  branch: "feat/x",
};

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("scrubSecrets", () => {
  it("redacts cogni agent keys, gh tokens, bearer headers, and sk- keys", () => {
    const dirty = [
      "cogni_ag_sk_v1_eyJabc.def-ghi",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer abcdef0123456789ghijklmnop",
      "sk-0123456789abcdefghijklmno",
    ].join(" ");
    const clean = scrubSecrets(dirty);
    expect(clean).toContain("cogni_ag_sk_v1_[REDACTED]");
    expect(clean).toContain("gh_[REDACTED]");
    expect(clean).toContain("Bearer [REDACTED]");
    expect(clean).toContain("sk-[REDACTED]");
    expect(clean).not.toContain("eyJabc");
    expect(clean).not.toContain("0123456789abcdefghijklmnopqrstuvwxyz");
  });
});

describe("mapTranscriptToDevSession", () => {
  it("maps assistant turns with text, thinking, tool_use, usage, and model", () => {
    const jsonl = [
      line({
        type: "user",
        message: { role: "user", content: "fix the bug" },
        timestamp: "2026-06-01T00:00:00Z",
      }),
      line({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "thinking", thinking: "let me look" },
            { type: "text", text: "Running the test." },
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
          usage: { input_tokens: 120, output_tokens: 45 },
        },
        timestamp: "2026-06-01T00:00:01Z",
      }),
    ].join("\n");

    const draft = mapTranscriptToDevSession(jsonl, META);

    expect(draft.sessionId).toBe("sess-abc");
    expect(draft.source).toBe(DEV_SESSION_SOURCE);
    expect(draft.tags).toContain(DEV_SESSION_SOURCE);
    expect(draft.tags).toContain("node:operator");
    expect(draft.turns).toHaveLength(2);

    const [user, assistant] = draft.turns;
    expect(user?.role).toBe("user");
    expect(user?.text).toBe("fix the bug");

    expect(assistant?.role).toBe("assistant");
    expect(assistant?.model).toBe("claude-opus-4-8");
    expect(assistant?.tokensIn).toBe(120);
    expect(assistant?.tokensOut).toBe(45);
    expect(assistant?.text).toContain("[thinking] let me look");
    expect(assistant?.text).toContain("Running the test.");
    expect(assistant?.tools).toHaveLength(1);
    expect(assistant?.tools[0]?.name).toBe("Bash");
    expect(assistant?.tools[0]?.toolUseId).toBe("tu_1");
    expect(assistant?.tools[0]?.input).toContain("pnpm test");

    expect(draft.metadata.totalTokensIn).toBe(120);
    expect(draft.metadata.totalTokensOut).toBe(45);
    expect(draft.metadata.turnCount).toBe(2);
  });

  it("captures tool_result content from user turns", () => {
    const jsonl = line({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "exit 0, all green",
          },
        ],
      },
    });
    const draft = mapTranscriptToDevSession(jsonl, META);
    expect(draft.turns).toHaveLength(1);
    expect(draft.turns[0]?.text).toContain("[tool_result] exit 0, all green");
  });

  it("scrubs secrets in turn text and tool input", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: {
          role: "assistant",
          model: "m",
          content: [
            { type: "text", text: "key is cogni_ag_sk_v1_abc.def123456" },
            {
              type: "tool_use",
              id: "t",
              name: "curl",
              input: { h: "Bearer abcdef0123456789ghijklmnop" },
            },
          ],
        },
      }),
    ].join("\n");
    const draft = mapTranscriptToDevSession(jsonl, META);
    expect(draft.turns[0]?.text).toContain("cogni_ag_sk_v1_[REDACTED]");
    expect(draft.turns[0]?.text).not.toContain("def123456");
    expect(draft.turns[0]?.tools[0]?.input).toContain("Bearer [REDACTED]");
  });

  it("tolerates malformed and irrelevant lines without throwing", () => {
    const jsonl = [
      "not json at all",
      "",
      "   ",
      line({ type: "summary", summary: "x" }),
      line({ type: "system", content: "hook ran" }),
      line({ type: "user", message: { role: "user", content: "hi" } }),
      "{partial",
    ].join("\n");
    const draft = mapTranscriptToDevSession(jsonl, META);
    expect(draft.turns).toHaveLength(1);
    expect(draft.turns[0]?.text).toBe("hi");
  });

  it("skips empty turns (no text, no tools)", () => {
    const jsonl = line({
      type: "assistant",
      message: { role: "assistant", content: [] },
    });
    const draft = mapTranscriptToDevSession(jsonl, META);
    expect(draft.turns).toHaveLength(0);
  });

  it("caps turn text and flags truncation past MAX_TURNS", () => {
    const huge = "x".repeat(MAX_TURN_TEXT_BYTES * 2);
    const lines: string[] = [
      line({ type: "user", message: { role: "user", content: huge } }),
    ];
    for (let i = 0; i < MAX_TURNS + 50; i++) {
      lines.push(
        line({ type: "user", message: { role: "user", content: `m${i}` } })
      );
    }
    const draft = mapTranscriptToDevSession(lines.join("\n"), META);
    expect(draft.turns[0]?.text.length).toBeLessThanOrEqual(
      MAX_TURN_TEXT_BYTES
    );
    expect(draft.turns[0]?.text.endsWith("…[truncated]")).toBe(true);
    expect(draft.turns).toHaveLength(MAX_TURNS);
    expect(draft.truncatedTurns).toBe(true);
  });

  it("omits node tag when node is null", () => {
    const draft = mapTranscriptToDevSession("", { ...META, node: null });
    expect(draft.tags).toEqual([DEV_SESSION_SOURCE]);
    expect(draft.turns).toHaveLength(0);
  });
});
