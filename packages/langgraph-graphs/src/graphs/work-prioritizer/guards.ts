// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/guards`
 * Purpose: Deterministic run guards: hub context before judging, and where EDO rows are filed (design v4).
 * Scope: Pure functions over parsed model output + the run context; does not call tools/LLMs or read env.
 * Invariants:
 *   - CONTEXT_BEFORE_JUDGMENT: a run with no knowledge AND no EDO context is rejected outright.
 * Side-effects: none
 * Links: schema.ts, plan.ts, .context/prioritizer-design-v4.md
 * @public
 */

import type { FetchedEntry, GatheredContext } from "./context";

/** CONTEXT_BEFORE_JUDGMENT: at least one knowledge or EDO entry was read. */
export const hasHubContext = (c: GatheredContext["contextConsumed"]) =>
  c.knowledgeIds.length + c.edoIds.length > 0;

/**
 * EDO_DOMAIN_FOLLOWS_CONTEXT: file EDO rows where the node keeps its goals — the domain of the first
 * active goal fetched this cycle, else the first knowledge entry's, else "strategy".
 */
export function selectEdoDomain(
  goals: readonly string[],
  entries: readonly FetchedEntry[]
): string {
  const usable = (e: FetchedEntry | undefined) =>
    e && e.domain !== "unknown" ? e.domain : undefined;
  return (
    goals.map((id) => usable(entries.find((e) => e.id === id))).find(Boolean) ??
    usable(
      entries.find((e) => e.plane === "knowledge" && e.domain !== "unknown")
    ) ??
    "strategy"
  );
}
