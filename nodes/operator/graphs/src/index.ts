// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/operator-graphs`
 * Purpose: Compose operator-owned product graphs with the operator's temporary Cogni qualification pilot.
 * Scope: Catalog binding only; shared tool implementations stay in immutable packages.
 * Invariants:
 *   - OPERATOR_CATALOG_IS_LOCAL
 *   - COGNI_QUALIFICATION_IS_TEMPORARY: the operator qualifies the shared Cogni mechanism in this workspace
 *     (story.5116, Derek 2026-10-26); node-template adopts the proven version through node-sync-prs.
 *     The operator catalog owns the runtime selection during qualification.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111, story.5116
 * @public
 */

import {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  type LangGraphCatalog,
  OPERATOR_LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_GRAPH_IDS,
} from "@cogni/langgraph-graphs";

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
} from "@cogni/ai-tools";

// These programs are this node's AI, not their human requester. Catalog identity
// is explicit at composition; the launcher never falls back to a caller/system actor.
const nodeAiCatalog = Object.fromEntries(
  Object.entries(OPERATOR_LANGGRAPH_CATALOG).map(([id, entry]) => [
    id,
    { ...entry, principal: "node-ai", workItemUpdateFields: [] },
  ])
);

const cogniWorkReview = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
if (!cogniWorkReview)
  throw new Error("Operator Cogni graph is missing work-prioritizer");
export const LANGGRAPH_CATALOG: LangGraphCatalog &
  Readonly<
    Record<
      string,
      {
        readonly principal?: string;
        readonly workItemUpdateFields?: "all" | readonly string[];
      }
    >
  > = {
  ...nodeAiCatalog,
  brain: {
    ...OPERATOR_LANGGRAPH_CATALOG.brain,
    principal: "node-ai",
    workItemUpdateFields: [],
    toolIds: [
      ...OPERATOR_LANGGRAPH_CATALOG.brain.toolIds,
      EDO_HYPOTHESIZE_NAME,
      EDO_DECIDE_NAME,
      EDO_RECORD_OUTCOME_NAME,
    ],
  },
  cogni: {
    ...OPERATOR_LANGGRAPH_CATALOG.cogni,
    principal: "node-ai",
    workItemUpdateFields: [],
  },
  "operating-review": {
    ...OPERATOR_LANGGRAPH_CATALOG["operating-review"],
    principal: "operating-review",
    // operator/prompts.ts: triage priority/status and flag labels/summary.
    workItemUpdateFields: ["priority", "status", "labels", "summary"],
  },
  "work-prioritizer": {
    ...cogniWorkReview,
    principal: "prioritizer",
    // work-prioritizer/prompts.ts limits item edits, even if a tool is added later.
    workItemUpdateFields: ["priority", "rank", "labels"],
  },
};
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  OPERATOR_LANGGRAPH_GRAPH_IDS as LANGGRAPH_GRAPH_IDS,
};
export * from "@cogni/langgraph-graphs/graphs";
