// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/host-preamble`
 * Purpose: Build the one host-owned grounding preamble that hub-grounded graphs share.
 *   It carries fail-closed node identity, this node's mission, the governing index and a
 *   graph-specific coverage instruction.
 * Scope: Pure string/message builder over `sourceContext`. Does not read env or call tools.
 * Invariants:
 *   - FAIL_CLOSED_IDENTITY: throws `node_source_identity_unavailable` without node identity and
 *     `node_mission_source_unavailable` without a mission, before any model or tool call.
 *   - REQUIRE_INDEX_OPT_IN (story.5102): `requireIndex: true` throws `governing_index_unavailable`
 *     when the index is empty. Only pr-review sets it; `cogni` keeps rendering without an index.
 *   - BYTE_STABLE_FOR_COGNI: the rendered text for `cogni` is unchanged by the extraction.
 *   - ARCHITECT_OPT_IN (task.5455): `includeArchitect: true` renders the host-read node architect
 *     entry after the mission. Only pr-review sets it; without the flag the text is byte-identical.
 * Side-effects: none
 * Links: graphs/operator/cogni.ts, graphs/pr-review/graph.ts,
 *   https://cognidao.org/knowledge/pr-review-grounded-gate
 * @public
 */

import { SystemMessage } from "@langchain/core/messages";
import type { CreateReactAgentGraphOptions } from "./types";

export interface HostPreambleInput {
  readonly sourceContext: CreateReactAgentGraphOptions["sourceContext"];
  /** The graph's role prompt, rendered first. */
  readonly prompt: string;
  /** The graph's systematic-coverage instruction, rendered last. */
  readonly coverage: string;
  /** Throw when the governing index is empty (pr-review only). */
  readonly requireIndex?: boolean;
  /** Render the host-injected node architect entry after the mission (pr-review only). */
  readonly includeArchitect?: boolean;
}

/** Render the host-owned preamble text. Throws (fail-closed) on missing grounding. */
export function buildHostPreambleText(input: HostPreambleInput): string {
  const sourceContext = input.sourceContext;
  if (!sourceContext?.nodeId || !sourceContext.origin)
    throw new Error("node_source_identity_unavailable");
  const mission = sourceContext.mission;
  if (!mission?.content.trim())
    throw new Error("node_mission_source_unavailable");
  const index = sourceContext.governingIndex ?? [];
  if (input.requireIndex && index.length === 0)
    throw new Error("governing_index_unavailable");
  const architect = input.includeArchitect
    ? sourceContext.architect
    : undefined;
  const architectBlock = architect?.content.trim()
    ? `\n\nHost-owned node architect (${architect.id}):\n${architect.content}`
    : "";
  const indexBlock = index.length
    ? `\n\nYour governing index (${index.length} entries; metadata only — read bodies on demand). Select the entries whose use-when fits your task and read each full body with core__knowledge_read before acting:\n${index
        .map((e) => `- ${e.id} · ${e.domain} · ${e.entryType} — ${e.useWhen}`)
        .join("\n")}`
    : "";
  return `${input.prompt}\n\nHost-owned node mission (${mission.sourceRef}; serving build ${mission.buildSha ?? "local/unversioned"}):\n${mission.content}${architectBlock}${indexBlock}\n\n${input.coverage}`;
}

/** The preamble as a SystemMessage, built per invoke (never stored). */
export function buildHostPreamble(input: HostPreambleInput): SystemMessage {
  return new SystemMessage(buildHostPreambleText(input));
}
