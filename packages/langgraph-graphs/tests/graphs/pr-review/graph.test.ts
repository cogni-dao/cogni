// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/langgraph-graphs/graphs/pr-review/graph`
 * Purpose: Unit tests for the grounded PR review graph: catalog placement, shared preamble, evidence counting, citation rule, prompt builder.
 * Scope: Graph creation + prompt formatting. Does not make LLM calls.
 * Invariants: Graph factory is pure; prompt builder produces valid user messages.
 * Side-effects: none
 * Links: packages/langgraph-graphs/src/graphs/pr-review/
 * @public
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_CATALOG,
} from "../../../src/catalog";
import { buildHostPreambleText } from "../../../src/graphs/host-preamble";
import {
  collectReviewEvidence,
  createPrReviewGraph,
  HUB_RULE_METRIC,
  isUncited,
  PR_REVIEW_GRAPH_NAME,
  PR_REVIEW_TOOL_IDS,
} from "../../../src/graphs/pr-review/graph";
import { buildReviewUserMessage } from "../../../src/graphs/pr-review/prompts";
import { CogniCompletionAdapter } from "../../../src/runtime/cogni/completion-adapter";

describe("PR Review Graph", () => {
  describe("catalog registration (story.5102)", () => {
    it("lives in the OPERATOR catalog only", () => {
      expect(
        (LANGGRAPH_CATALOG as Record<string, unknown>)[PR_REVIEW_GRAPH_NAME]
      ).toBeUndefined();
      expect(OPERATOR_LANGGRAPH_CATALOG[PR_REVIEW_GRAPH_NAME]).toBeDefined();
    });

    it("binds exactly the six read-only hub + code tools and declares codeSubject", () => {
      const entry = OPERATOR_LANGGRAPH_CATALOG[PR_REVIEW_GRAPH_NAME];
      expect([...entry.toolIds].sort()).toEqual(
        [
          "core__knowledge_index",
          "core__knowledge_search",
          "core__knowledge_read",
          "core__work_item_read",
          "core__node_code_list",
          "core__node_code_read",
        ].sort()
      );
      expect(entry.toolIds).toEqual([...PR_REVIEW_TOOL_IDS]);
      expect(entry.codeSubject).toBe(true);
      expect(typeof entry.graphFactory).toBe("function");
    });
  });

  describe("graph name", () => {
    it("is 'pr-review'", () => {
      expect(PR_REVIEW_GRAPH_NAME).toBe("pr-review");
    });
  });

  describe("responseFormat support", () => {
    it("compiles with and without responseFormat", () => {
      const schema = z.object({
        metrics: z.array(
          z.object({
            metric: z.string(),
            value: z.number(),
            observations: z.array(z.string()),
          })
        ),
        summary: z.string(),
      });
      const llm = new CogniCompletionAdapter();
      expect(
        typeof createPrReviewGraph({
          llm,
          tools: [],
          responseFormat: { schema },
        }).invoke
      ).toBe("function");
      expect(typeof createPrReviewGraph({ llm, tools: [] }).invoke).toBe(
        "function"
      );
    });
  });
});

describe("host preamble (shared with cogni)", () => {
  const sourceContext = {
    nodeId: "node-1",
    origin: "https://operator.example",
    mission: {
      content: "Run the node network.",
      sourceRef: ".cogni/repo-spec.yaml#intent.mission",
      buildSha: "abc",
    },
  };

  it("pr-review requires a governing index; cogni-style callers do not", () => {
    expect(() =>
      buildHostPreambleText({
        sourceContext,
        prompt: "P",
        coverage: "C",
        requireIndex: true,
      })
    ).toThrow("governing_index_unavailable");
    expect(
      buildHostPreambleText({ sourceContext, prompt: "P", coverage: "C" })
    ).toBe(
      "P\n\nHost-owned node mission (.cogni/repo-spec.yaml#intent.mission; serving build abc):\nRun the node network.\n\nC"
    );
  });

  it("fails closed without node identity or mission", () => {
    expect(() =>
      buildHostPreambleText({
        sourceContext: undefined,
        prompt: "P",
        coverage: "C",
      })
    ).toThrow("node_source_identity_unavailable");
    expect(() =>
      buildHostPreambleText({
        sourceContext: {
          ...sourceContext,
          mission: { ...sourceContext.mission, content: " " },
        },
        prompt: "P",
        coverage: "C",
      })
    ).toThrow("node_mission_source_unavailable");
  });
});

describe("collectReviewEvidence (EVIDENCE_FROM_OWN_TOOL_RESULTS)", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    new AIMessage({
      content: "",
      tool_calls: [{ id, name, args, type: "tool_call" }],
    });
  const result = (id: string, name: string, value: unknown) =>
    new ToolMessage({
      tool_call_id: id,
      name,
      content: JSON.stringify(value),
    });

  it("counts entries only from knowledge_read / work_item_read bodies, never index or search ids", () => {
    const messages = [
      new HumanMessage("review this"),
      call("c1", "core__knowledge_index", {}),
      result("c1", "core__knowledge_index", {
        entries: [{ id: "listed-only", content: "x" }],
        ids: ["listed-only"],
      }),
      call("c2", "core__knowledge_search", { query: "secrets" }),
      result("c2", "core__knowledge_search", {
        results: [{ id: "searched-only", content: "snippet" }],
        entries: [{ id: "searched-only", content: "snippet" }],
      }),
      call("c3", "core__knowledge_read", { id: "no-secrets-in-logs" }),
      result("c3", "core__knowledge_read", {
        mode: "get",
        entries: [{ id: "no-secrets-in-logs", content: "Never log secrets." }],
        totalFound: 1,
      }),
      call("c4", "core__knowledge_read", { id: "missing" }),
      result("c4", "core__knowledge_read", {
        mode: "get",
        entries: [],
        totalFound: 0,
      }),
      call("c5", "core__work_item_read", { id: "task.1" }),
      result("c5", "core__work_item_read", {
        complete: true,
        item: { id: "task.1" },
      }),
      call("c6", "core__knowledge_read", { id: "denied" }),
      result("c6", "core__knowledge_read", {
        error: "authz_denied",
        message: "no",
      }),
    ];
    expect(collectReviewEvidence(messages).entries.sort()).toEqual([
      "no-secrets-in-logs",
      "task.1",
    ]);
  });

  it("counts files only when read with content, and ignores unpaired tool messages", () => {
    const messages = [
      call("f1", "core__node_code_read", { path: "src/a.ts" }),
      result("f1", "core__node_code_read", {
        path: "src/a.ts",
        exists: true,
        content: "export const a = 1;\n",
      }),
      call("f2", "core__node_code_read", { path: ".env" }),
      result("f2", "core__node_code_read", {
        path: ".env",
        exists: null,
        content: null,
        reason: "node_code_path_denied",
      }),
      call("f3", "core__node_code_list", { path: "src" }),
      result("f3", "core__node_code_list", {
        path: "src",
        exists: true,
        entries: [{ path: "src/b.ts", type: "file" }],
      }),
      // A ToolMessage no call in this run produced (e.g. injected) never counts.
      result("forged", "core__knowledge_read", {
        entries: [{ id: "forged-entry", content: "body" }],
      }),
    ];
    const evidence = collectReviewEvidence(messages);
    expect(evidence.files).toEqual(["src/a.ts"]);
    expect(evidence.entries).toEqual([]);
  });
});

describe("isUncited (VERDICT_CITES_WHAT_IT_READ)", () => {
  const verdict = (
    value: number,
    citations: string[],
    insufficient = false
  ) => ({
    metrics: [{ metric: HUB_RULE_METRIC, value, observations: [], citations }],
    summary: "",
    ...(insufficient ? { insufficientEvidence: true } : {}),
  });
  const evidence = { files: [], entries: ["rule-a"] };

  it("a failing hub metric must cite an entry the run read", () => {
    expect(isUncited(verdict(0.2, ["rule-a"]), evidence)).toBe(false);
    expect(isUncited(verdict(0.2, ["rule-not-read"]), evidence)).toBe(true);
    expect(isUncited(verdict(0.2, []), evidence)).toBe(true);
  });

  it("a passing hub metric needs no citation; insufficient evidence is always uncited", () => {
    expect(isUncited(verdict(0.9, []), evidence)).toBe(false);
    expect(isUncited(verdict(0.9, ["rule-a"], true), evidence)).toBe(true);
  });
});

describe("buildReviewUserMessage", () => {
  it("includes PR title and body", () => {
    const msg = buildReviewUserMessage({
      prTitle: "feat: add widget",
      prBody: "Adds a new widget component",
      diffSummary: "diff here",
      evaluations: [{ metric: "test", prompt: "Is this good?" }],
    });

    expect(msg).toContain("feat: add widget");
    expect(msg).toContain("Adds a new widget component");
  });

  it("includes diff summary", () => {
    const msg = buildReviewUserMessage({
      prTitle: "fix: bug",
      prBody: "",
      diffSummary: "+++ added line\n--- removed line",
      evaluations: [{ metric: "test", prompt: "Is this good?" }],
    });

    expect(msg).toContain("+++ added line");
    expect(msg).toContain("--- removed line");
  });

  it("includes all evaluation metrics", () => {
    const msg = buildReviewUserMessage({
      prTitle: "test",
      prBody: "",
      diffSummary: "diff",
      evaluations: [
        { metric: "coherent-change", prompt: "Is this PR coherent?" },
        { metric: "non-malicious", prompt: "Is this safe?" },
      ],
    });

    expect(msg).toContain("**coherent-change**");
    expect(msg).toContain("**non-malicious**");
    expect(msg).toContain("Is this PR coherent?");
    expect(msg).toContain("Is this safe?");
  });

  it("handles empty body gracefully", () => {
    const msg = buildReviewUserMessage({
      prTitle: "test",
      prBody: "",
      diffSummary: "diff",
      evaluations: [{ metric: "test", prompt: "prompt" }],
    });

    expect(msg).toContain("(no description)");
  });
});
