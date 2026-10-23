// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/operator-graphs`
 * Purpose: Compose the published prioritizer baseline with operator-owned product graphs.
 * Scope: Catalog binding only; shared graph/tool implementations stay in immutable packages.
 * Invariants: OPERATOR_CATALOG_IS_LOCAL; PRIORITIZER_FROM_RELEASE.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111
 * @public
 */

import {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  type LangGraphCatalog,
  OPERATOR_LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_GRAPH_IDS,
} from "@cogni/langgraph-graphs";

import { LANGGRAPH_CATALOG as SHARED_LANGGRAPH_CATALOG } from "@cogni/shared-langgraph-graphs";

const sharedPrioritizer = SHARED_LANGGRAPH_CATALOG["work-prioritizer"];
if (!sharedPrioritizer) throw new Error("Shared evaluation release is missing work-prioritizer");
export const LANGGRAPH_CATALOG: LangGraphCatalog = {
  ...OPERATOR_LANGGRAPH_CATALOG,
  "work-prioritizer": sharedPrioritizer,
};
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  OPERATOR_LANGGRAPH_GRAPH_IDS as LANGGRAPH_GRAPH_IDS,
};
export * from "@cogni/langgraph-graphs/graphs";
