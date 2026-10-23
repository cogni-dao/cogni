// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-index`
 * Purpose: AI tool that returns the node hub's governing guidance index — every skill, guide, playbook, rule, design, decision and reference with its use-when trigger — so an internal agent can pick the entries that govern its task.
 * Scope: Read-only over `KnowledgeCapability.listGoverningIndex`. Does not read bodies, filter rows or import any node or store package.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__knowledge_index`
 *   - EFFECT_TYPED: effect is `read_only`; `requires: "node.collaborate"`
 *   - ONE_SOURCE_SEPARATE_ADAPTERS: rows come only from `listGoverningIndex()`, the same reader the session bundle renders; the tool never filters or re-ranks them
 *   - INDEX_CARRIES_NO_CONTENT: rows carry id, domain, entryType and useWhen only
 *   - SELECT_THEN_LOAD: the description tells the agent to read each chosen entry with core__knowledge_read before acting
 *   - NODE_LOCAL_RUNTIME: the capability reads the agent's own hub; no operator credential is involved
 *   - INDEX_OUTPUT_CAPPED: rows above `KNOWLEDGE_INDEX_MAX_BYTES` fall back to the `method` shelf plus `omittedDomains`, like the bundle past 64 KiB
 * Side-effects: IO (reads the governing index via capability)
 * Links: https://cognidao.org/knowledge/guidance-routing-design, task.5304
 * @public
 */

import { z } from "zod";

import type { KnowledgeCapability } from "../capabilities/knowledge";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const KnowledgeIndexInputSchema = z.object({}).strict();
export type KnowledgeIndexInput = z.infer<typeof KnowledgeIndexInputSchema>;

export const KnowledgeIndexOutputSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      domain: z.string(),
      entryType: z.string(),
      useWhen: z.string(),
    })
  ),
  /** True when the rows exceeded `KNOWLEDGE_INDEX_MAX_BYTES` and only the `method` shelf is returned. */
  truncated: z.boolean(),
  /** Domains whose rows were left out when truncated (sorted); empty otherwise. */
  omittedDomains: z.array(z.string()),
});
export type KnowledgeIndexOutput = z.infer<typeof KnowledgeIndexOutputSchema>;

export const KNOWLEDGE_INDEX_NAME = "core__knowledge_index" as const;

/**
 * INDEX_OUTPUT_CAPPED: serialized rows above this many bytes fall back like the
 * session bundle past its 64 KiB budget — only the `method` shelf is returned,
 * with the omitted domains named so the agent can read them by shelf.
 */
export const KNOWLEDGE_INDEX_MAX_BYTES = 48 * 1024;

/** The shelf kept when the index exceeds the cap (matches the bundle fallback). */
const INLINE_FALLBACK_SHELF = "method";

export const knowledgeIndexContract: ToolContract<
  typeof KNOWLEDGE_INDEX_NAME,
  KnowledgeIndexInput,
  KnowledgeIndexOutput,
  KnowledgeIndexOutput
> = {
  name: KNOWLEDGE_INDEX_NAME,
  description:
    "List this node's governing guidance index: every skill, guide, playbook, rule, design, decision and reference, " +
    "each with its id, domain, type and use-when trigger. Pick the entries whose use-when matches your task, " +
    "then read each chosen entry with core__knowledge_read before acting. " +
    "If the result is truncated (too large), only the method shelf is listed; omittedDomains names the other shelves to search with core__knowledge_search.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema: KnowledgeIndexInputSchema,
  outputSchema: KnowledgeIndexOutputSchema,
  redact: (output) => output,
  allowlist: ["entries", "truncated", "omittedDomains"] as const,
};

export interface KnowledgeIndexDeps {
  readonly knowledgeCapability: KnowledgeCapability;
}

export function createKnowledgeIndexImplementation(
  deps: KnowledgeIndexDeps
): ToolImplementation<KnowledgeIndexInput, KnowledgeIndexOutput> {
  return {
    execute: async () => {
      const list = deps.knowledgeCapability.listGoverningIndex;
      if (!list)
        throw new Error(
          "knowledge_index_unavailable: no governing index reader on this node"
        );
      const rows = await list.call(deps.knowledgeCapability);
      const entries = rows.map(({ id, domain, entryType, useWhen }) => ({
        id,
        domain,
        entryType,
        useWhen,
      }));
      if (
        new TextEncoder().encode(JSON.stringify(entries)).byteLength <=
        KNOWLEDGE_INDEX_MAX_BYTES
      )
        return { entries, truncated: false, omittedDomains: [] };
      return {
        entries: entries.filter((e) => e.domain === INLINE_FALLBACK_SHELF),
        truncated: true,
        omittedDomains: [
          ...new Set(
            entries
              .map((e) => e.domain)
              .filter((d) => d !== INLINE_FALLBACK_SHELF)
          ),
        ].sort(),
      };
    },
  };
}

export const knowledgeIndexStubImplementation: ToolImplementation<
  KnowledgeIndexInput,
  KnowledgeIndexOutput
> = {
  execute: async () => {
    throw new Error(
      "knowledge_index_unavailable: KnowledgeCapability not configured."
    );
  },
};

export const knowledgeIndexBoundTool: BoundTool<
  typeof KNOWLEDGE_INDEX_NAME,
  KnowledgeIndexInput,
  KnowledgeIndexOutput,
  KnowledgeIndexOutput
> = {
  contract: knowledgeIndexContract,
  implementation: knowledgeIndexStubImplementation,
};
