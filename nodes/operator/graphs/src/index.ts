// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/operator-graphs`
 * Purpose: Compose operator-owned product graphs with the operator's steward (work-prioritizer) graph.
 * Scope: Catalog binding only; shared tool implementations stay in immutable packages.
 * Invariants:
 *   - OPERATOR_CATALOG_IS_LOCAL
 *   - STEWARD_ITERATES_LOCALLY: the operator iterates its own steward prompt + grader in this workspace
 *     (story.5116, Derek 2026-10-26); node-template adopts the proven version through node-sync-prs.
 *     The shared release baseline is still verified present so the pin stays honest.
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

import { LANGGRAPH_CATALOG as SHARED_LANGGRAPH_CATALOG } from "@cogni/shared-langgraph-graphs";

if (!SHARED_LANGGRAPH_CATALOG["work-prioritizer"])
  throw new Error("Shared evaluation release is missing work-prioritizer");
const stewardPrioritizer = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
if (!stewardPrioritizer) throw new Error("Operator steward graph is missing work-prioritizer");
export const LANGGRAPH_CATALOG: LangGraphCatalog = {
  ...OPERATOR_LANGGRAPH_CATALOG,
  "work-prioritizer": stewardPrioritizer,
};
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  OPERATOR_LANGGRAPH_GRAPH_IDS as LANGGRAPH_GRAPH_IDS,
};
export * from "@cogni/langgraph-graphs/graphs";
