// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/operator/cogni-exec`
 * Purpose: Cogni executor entrypoint for the mission-loop graph (Next.js runtime).
 * Scope: Thin entrypoint. Does NOT import catalog or read env. Model + tools resolve from
 *   ALS/configurable at invoke time via makeCogniGraph.
 * Invariants:
 *   - HELPERS_DO_NOT_IMPORT_CATALOG: Uses makeCogniGraph with explicit toolIds
 *   - NO_CROSSING_THE_STREAMS: Never imports initChatModel or reads env
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5367
 * @public
 */
import { makeCogniGraph } from "../../runtime/cogni/make-cogni-graph";
import { COGNI_TOOL_IDS } from "./cogni";
import { createOperatorGraph } from "./graph";

export const cogniGraph = makeCogniGraph({
  name: "cogni",
  createGraph: createOperatorGraph,
  toolIds: COGNI_TOOL_IDS,
  program: "cogni",
});
