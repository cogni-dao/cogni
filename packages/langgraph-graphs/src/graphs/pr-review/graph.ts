// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/pr-review/graph`
 * Purpose: Grounded PR review graph with gather, verdict and finalize states.
 *   GATHER (ReAct over read-only hub + code tools) → VERDICT (structured output, no tools) →
 *   FINALIZE (host fields from the run's own tool results).
 * Scope: Pure graph factory. Does not read env, enforce authz or write anything.
 * Invariants:
 *   - REVIEW_ON_THE_HARNESS (story.5102): host-owned grounding via the shared preamble with
 *     `requireIndex: true` (an empty governing index fails the run); harness bounds only — no
 *     custom tool cap.
 *   - REVIEW_READS_ALL_WRITES_NONE: tools are the six read_only ids in PR_REVIEW_TOOL_IDS.
 *   - RECURSION_GOES_TO_VERDICT: a GraphRecursionError during gather proceeds to the verdict with
 *     what was read (as `cogni` does).
 *   - EVIDENCE_FROM_OWN_TOOL_RESULTS: finalize pairs each tool call with its ToolMessage by
 *     tool_call_id. `evidence.entries` counts ONLY entries whose bodies came back from
 *     core__knowledge_read (and core__work_item_read items) — never index/search id lists.
 *     `evidence.files` counts only files read with content.
 *   - HOST_FIELDS_NOT_MODEL_FIELDS: `evidence`, `uncited` and `buildSha` are added by finalize and
 *     are never part of the model's schema.
 *   - VERDICT_CITES_WHAT_IT_READ: a cited id counts only if it is in evidence.entries; a failing
 *     hub metric with no counted citation, or `insufficientEvidence`, sets `uncited: true`.
 *   - TYPE_TRANSPARENT_RETURN: no explicit return type annotation.
 * Side-effects: IO (injected read-only tool calls)
 * Links: https://cognidao.org/knowledge/pr-review-grounded-gate, story.5102,
 *   nodes/operator/.cogni/rules/hub-rule-compliance.yaml
 * @public
 */

import {
  KNOWLEDGE_INDEX_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  NODE_CODE_LIST_NAME,
  NODE_CODE_READ_NAME,
  WORK_ITEM_READ_NAME,
} from "@cogni/ai-tools";
import {
  type BaseMessage,
  isAIMessage,
  isToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  END,
  GraphRecursionError,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { buildHostPreamble } from "../host-preamble";
import type { CreateReactAgentGraphOptions } from "../types";
import {
  PR_REVIEW_COVERAGE,
  PR_REVIEW_SYSTEM_PROMPT,
  PR_REVIEW_VERDICT_INSTRUCTION,
} from "./prompts";

/** Graph name constant for routing. */
export const PR_REVIEW_GRAPH_NAME = "pr-review" as const;

/** The reviewer's read-only tools (REVIEW_READS_ALL_WRITES_NONE). */
export const PR_REVIEW_TOOL_IDS = [
  KNOWLEDGE_INDEX_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  WORK_ITEM_READ_NAME,
  NODE_CODE_LIST_NAME,
  NODE_CODE_READ_NAME,
] as const;

/** The hub-rule metric (nodes/operator/.cogni/rules/hub-rule-compliance.yaml) and its threshold. */
export const HUB_RULE_METRIC = "complies-with-governing-hub-rules" as const;
export const HUB_RULE_THRESHOLD = 0.7;

/** Verdict attempts: one call plus one bounded re-ask on an unparseable answer. */
const MAX_VERDICT_ATTEMPTS = 2;

/** Model verdict (the `evaluation-output` schema). */
export interface PrReviewVerdict {
  metrics: Array<{
    metric: string;
    value: number;
    observations: string[];
    citations?: string[];
  }>;
  summary: string;
  insufficientEvidence?: boolean;
}

/** Host evidence: what this run actually read. */
export interface PrReviewEvidence {
  files: string[];
  entries: string[];
}

type StructuredModel = {
  withStructuredOutput: (
    schema: unknown,
    options?: Record<string, unknown>
  ) => {
    invoke: (
      messages: BaseMessage[],
      config?: RunnableConfig
    ) => Promise<unknown>;
  };
};

const PrReviewState = Annotation.Root({
  ...MessagesAnnotation.spec,
  abortReason: Annotation<string | undefined>(),
  modelVerdict: Annotation<PrReviewVerdict | undefined>(),
  structuredResponse: Annotation<Record<string, unknown> | undefined>(),
});

const textOf = (m: BaseMessage): string => {
  const c = m.content;
  return Array.isArray(c)
    ? c
        .map((p) => (typeof p === "string" ? p : "text" in p ? p.text : ""))
        .join("")
    : String(c ?? "");
};

const parseJson = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

const isEmptyCompletion = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("empty_model_completion");

/**
 * EVIDENCE_FROM_OWN_TOOL_RESULTS: pair each tool call with its ToolMessage by tool_call_id and
 * count only bodies actually returned. Index/search results list ids — they never count.
 */
export function collectReviewEvidence(
  messages: readonly BaseMessage[]
): PrReviewEvidence {
  const calls = new Map<string, string>();
  for (const m of messages) {
    if (!isAIMessage(m)) continue;
    for (const call of m.tool_calls ?? []) {
      if (call.id) calls.set(call.id, call.name);
    }
  }
  const files = new Set<string>();
  const entries = new Set<string>();
  for (const m of messages) {
    if (!isToolMessage(m)) continue;
    const name = calls.get(m.tool_call_id);
    if (!name) continue; // not a tool call this run made
    const v = parseJson(textOf(m));
    if (!v || typeof v.error === "string") continue;
    if (name === KNOWLEDGE_READ_NAME && Array.isArray(v.entries)) {
      for (const e of v.entries as Array<Record<string, unknown>>) {
        if (
          typeof e?.id === "string" &&
          typeof e.content === "string" &&
          e.content.trim().length > 0
        )
          entries.add(e.id);
      }
    } else if (name === WORK_ITEM_READ_NAME && v.complete === true) {
      const id = (v.item as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") entries.add(id);
    } else if (
      name === NODE_CODE_READ_NAME &&
      v.exists === true &&
      typeof v.content === "string" &&
      typeof v.path === "string"
    ) {
      files.add(v.path);
    }
  }
  return { files: [...files], entries: [...entries] };
}

/** VERDICT_CITES_WHAT_IT_READ: should this verdict be treated as "could not evaluate"? */
export function isUncited(
  verdict: PrReviewVerdict,
  evidence: PrReviewEvidence
): boolean {
  if (verdict.insufficientEvidence === true) return true;
  const hub = verdict.metrics.find((m) => m.metric === HUB_RULE_METRIC);
  if (!hub || hub.value >= HUB_RULE_THRESHOLD) return false;
  const read = new Set(evidence.entries);
  return !(hub.citations ?? []).some((id) => read.has(id));
}

/**
 * Build the grounded PR review graph. Without `responseFormat` the run gathers and returns no
 * structured output (the worker then reports "could not evaluate").
 *
 * NOTE: Return type is intentionally NOT annotated (TYPE_TRANSPARENT_RETURN).
 */
export function createPrReviewGraph(opts: CreateReactAgentGraphOptions) {
  const allowed = new Set<string>(PR_REVIEW_TOOL_IDS);
  const tools = [...opts.tools].filter((tool) => allowed.has(tool.name));

  // Host-owned grounding, built per invoke (fail-closed), with the index REQUIRED.
  const buildPreamble = (): SystemMessage =>
    buildHostPreamble({
      sourceContext: opts.sourceContext,
      prompt: PR_REVIEW_SYSTEM_PROMPT,
      coverage: PR_REVIEW_COVERAGE,
      requireIndex: true,
    });

  const gather = createReactAgent({
    llm: opts.llm,
    tools,
    prompt: (state: typeof MessagesAnnotation.State) => [
      buildPreamble(),
      ...state.messages,
    ],
    stateSchema: MessagesAnnotation,
  });

  type S = typeof PrReviewState.State;

  const verdict = async (
    s: S,
    config?: RunnableConfig
  ): Promise<Partial<S>> => {
    const format = opts.responseFormat;
    if (!format) return {};
    const model = (opts.llm as unknown as StructuredModel).withStructuredOutput(
      format.schema
    );
    const instruction = format.prompt
      ? `${PR_REVIEW_VERDICT_INSTRUCTION}\n\n${format.prompt}`
      : PR_REVIEW_VERDICT_INSTRUCTION;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_VERDICT_ATTEMPTS; attempt++) {
      try {
        const result = (await model.invoke(
          [buildPreamble(), ...s.messages, new SystemMessage(instruction)],
          config
        )) as PrReviewVerdict;
        return { modelVerdict: result };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  return new StateGraph(PrReviewState)
    .addNode("gather", async (s: S, config: RunnableConfig) => {
      // Keep the latest transcript so a turn-limit abort still judges what was read.
      let last: { messages: BaseMessage[] } = { messages: s.messages };
      try {
        const values = await gather.stream(
          { messages: s.messages },
          { ...config, streamMode: "values" }
        );
        for await (const v of values) last = v;
        return last;
      } catch (error) {
        if (error instanceof GraphRecursionError)
          return { ...last, abortReason: "recursion_limit" };
        if (isEmptyCompletion(error)) return last;
        throw error;
      }
    })
    .addNode("verdict", verdict)
    .addNode("finalize", (s: S) => {
      if (!s.modelVerdict) return {};
      const evidence = collectReviewEvidence(s.messages);
      return {
        structuredResponse: {
          ...s.modelVerdict,
          evidence,
          uncited: isUncited(s.modelVerdict, evidence),
          buildSha: opts.sourceContext?.mission?.buildSha ?? null,
          ...(s.abortReason ? { abortReason: s.abortReason } : {}),
        },
      };
    })
    .addEdge(START, "gather")
    .addEdge("gather", "verdict")
    .addEdge("verdict", "finalize")
    .addEdge("finalize", END)
    .compile();
}
