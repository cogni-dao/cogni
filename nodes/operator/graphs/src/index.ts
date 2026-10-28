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
const cogniWorkReview = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
if (!cogniWorkReview) throw new Error("Operator Cogni graph is missing work-prioritizer");
export const LANGGRAPH_CATALOG: LangGraphCatalog = {
  ...OPERATOR_LANGGRAPH_CATALOG,
  "work-prioritizer": cogniWorkReview,
};
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  OPERATOR_LANGGRAPH_GRAPH_IDS as LANGGRAPH_GRAPH_IDS,
};
export * from "@cogni/langgraph-graphs/graphs";
