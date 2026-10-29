// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/mission/server`
 * Purpose: LangGraph dev server entrypoint for the Cogni mission-loop graph.
 * Scope: Thin dev entrypoint; does NOT import the catalog, read node bindings, or enforce
 *   policy. Renders the compiled phase-node graph (gather → decide → file → report) in
 *   LangGraph dev/Studio. Node identity (sourceContext) is supplied only by the node host at
 *   runtime, so a dev invocation fails closed when the preamble is built; the graph STRUCTURE
 *   still renders for inspection.
 * Invariants:
 *   - LANGGRAPH_JSON_POINTS_TO_SERVER_ONLY: Referenced by langgraph.json
 *   - HELPERS_DO_NOT_IMPORT_CATALOG: Uses makeServerGraph with explicit toolIds
 * Side-effects: process.env (via makeServerGraph)
 * Links: https://cognidao.org/work/items/task.5367
 * @internal
 */
import { makeServerGraph } from "../../runtime/core/make-server-graph";
import { COGNI_TOOL_IDS } from "./cogni";
import { createMissionGraph } from "./graph";

export const cogni = await makeServerGraph({
  name: "cogni",
  createGraph: createMissionGraph,
  toolIds: COGNI_TOOL_IDS,
  program: "cogni",
});
