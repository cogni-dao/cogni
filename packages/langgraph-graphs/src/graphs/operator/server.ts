// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/operator/server`
 * Purpose: Expose the same Cogni factory to LangGraph Studio for structural development.
 * Scope: Dev-only inspection. No authenticated node binding or production capability proof. Does not perform source mutations.
 * Invariants: Missing host source context returns incomplete before any tool/model invocation.
 * Side-effects: process.env (existing dev helper)
 * Links: https://cognidao.org/work/items/task.5367
 * @internal
 */
import { makeServerGraph } from "../../runtime/core/make-server-graph";
import { createOperatorGraph } from "./graph";
// Deliberately no stub tools or invented sourceContext. Actual capabilities enter via
// the local node GraphExecutorPort; this entry truthfully reports missing bindings.
export const cogni = await makeServerGraph({
  name: "cogni (dev: node bindings unavailable)",
  createGraph: createOperatorGraph,
  toolIds: [],
  program: "cogni",
});
