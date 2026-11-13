// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/langgraph-graphs/runtime/structured-output-parse`
 * Purpose: Prove withStructuredOutput takes the last balanced JSON object from prose-wrapped answers, still validates it, and fails closed.
 * Scope: CogniCompletionAdapter.withStructuredOutput + extractLastJsonObject with a fake completionFn. Does NOT make LLM calls.
 * Invariants: STRUCTURED_PARSE_TOLERATES_PROSE (bug.5626): last balanced object wins, Zod validates, no object throws.
 * Side-effects: none
 * Links: packages/langgraph-graphs/src/runtime/cogni/completion-adapter.ts
 * @internal
 */

import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CogniCompletionAdapter,
  type CompletionFn,
  extractLastJsonObject,
} from "../../src/runtime/cogni/completion-adapter";
import { runWithCogniExecContext } from "../../src/runtime/cogni/exec-context";

const Verdict = z.object({
  summary: z.string(),
  score: z.number(),
});
const VERDICT = { summary: "ok", score: 0.9 };

async function structured(text: string) {
  const completionFn: CompletionFn = () => ({
    stream: (async function* () {})(),
    final: Promise.resolve({
      ok: true as const,
      content: text,
      finishReason: "stop",
    }),
  });
  const llm = new CogniCompletionAdapter().bindRun("test-model");
  return runWithCogniExecContext(
    { completionFn, tokenSink: { push: vi.fn() }, toolExecFn: vi.fn() },
    () =>
      llm.withStructuredOutput(Verdict).invoke([new HumanMessage("judge")], {
        configurable: { model: "test-model" },
      })
  );
}

describe("withStructuredOutput tolerant parse (bug.5626)", () => {
  it("parses exact JSON and a fenced object as before", async () => {
    expect(await structured(JSON.stringify(VERDICT))).toEqual(VERDICT);
    expect(
      await structured(`\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``)
    ).toEqual(VERDICT);
  });

  it("takes the object after leading prose", async () => {
    expect(
      await structured(
        `Let me read the diff first.\n${JSON.stringify(VERDICT)}`
      )
    ).toEqual(VERDICT);
  });

  it("takes the object before trailing prose", async () => {
    expect(
      await structured(`${JSON.stringify(VERDICT)}\n\nHope that helps.`)
    ).toEqual(VERDICT);
  });

  it("takes a fenced object after a stray character", async () => {
    expect(
      await structured(`.\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``)
    ).toEqual(VERDICT);
    expect(
      await structured(`P\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``)
    ).toEqual(VERDICT);
  });

  it("with two objects the last one wins", async () => {
    const first = { summary: "draft", score: 0.1 };
    expect(
      await structured(
        `${JSON.stringify(first)} then ${JSON.stringify(VERDICT)}`
      )
    ).toEqual(VERDICT);
  });

  it("skips quoted PR JSON inside prose and takes the real verdict after it", async () => {
    const pr = JSON.stringify({
      title: "fix: a {brace} in a string",
      body: 'says "hi" and \\ backslash',
    });
    expect(
      await structured(
        `The PR payload was ${pr} and I read {it carefully}. Final answer:\n${JSON.stringify(VERDICT)}`
      )
    ).toEqual(VERDICT);
  });

  it("an unbalanced brace in prose does not hide the verdict", async () => {
    expect(
      await structured(
        `I saw a stray { in the diff. ${JSON.stringify(VERDICT)}`
      )
    ).toEqual(VERDICT);
  });

  it("still runs Zod validation on the extracted object", async () => {
    await expect(
      structured(`Here: ${JSON.stringify({ summary: "x", score: "high" })}`)
    ).rejects.toThrow();
  });

  it("throws when the text is empty or has no JSON object", async () => {
    await expect(structured("")).rejects.toThrow("invalid JSON");
    await expect(structured("I could not decide.")).rejects.toThrow(
      "invalid JSON"
    );
    await expect(structured("{not json}")).rejects.toThrow("invalid JSON");
  });
});

describe("extractLastJsonObject", () => {
  it("returns undefined for no object, the last top-level object otherwise", () => {
    expect(extractLastJsonObject("")).toBeUndefined();
    expect(extractLastJsonObject("{not json}")).toBeUndefined();
    expect(extractLastJsonObject('a {"x":1} b {"x":{"y":2}} c')).toEqual({
      x: { y: 2 },
    });
  });
});
