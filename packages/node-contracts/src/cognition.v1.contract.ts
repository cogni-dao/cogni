// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/cognition.v1.contract`
 * Purpose: HTTP response contract for a node's session-start cognition substrate bundle.
 *   Served at GET /api/v1/cognition (advertised via /.well-known/agent.json) in place of
 *   git-synced AGENTS.md sprawl.
 * Scope: Zod schemas + types for the wire format only. Does not contain business logic, I/O, or auth.
 * Invariants:
 *   - INDEX_NOT_CONTENT: bundle carries governing/domain POINTERS (id + type +
 *     domain + useWhen) — discovery metadata only, never entry bodies or excerpts.
 *     Full content stays behind the authed read routes
 *     (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: `toolingInvariants` + `markdown`
 *     render even when the hub is empty or unreachable, so a session always
 *     bootstraps.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-baas-substrate-model, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { z } from "zod";

/**
 * One governing index row (guidance-routing-design): an entry an agent designs,
 * builds and reviews against — skill, guide, playbook, rule, design, decision
 * or reference — with a useWhen and no inbound `supersedes` edge. Routing
 * metadata only, never title or body (INDEX_CARRIES_NO_CONTENT).
 */
export const CognitionGoverningPointerSchema = z.object({
  id: z.string(),
  entryType: z.string(),
  domain: z.string(),
  /** The entry's retrieval trigger — the reader's situation (`use_when`). */
  useWhen: z.string(),
});
export type CognitionGoverningPointer = z.infer<
  typeof CognitionGoverningPointerSchema
>;

export const CognitionDomainPointerSchema = z.object({
  domain: z.string(),
  description: z.string().nullable(),
  entryCount: z.number().int(),
});
export type CognitionDomainPointer = z.infer<
  typeof CognitionDomainPointerSchema
>;

export const CognitionBundleResponseSchema = z.object({
  /** Node UUID (node_id) — stable machine identity. */
  node: z.string(),
  /** Human-facing node slug from repo-spec `intent.name` (e.g. `operator`). */
  name: z.string(),
  /** One-line node mission from repo-spec `intent.mission`, null when undeclared. */
  mission: z.string().nullable(),
  version: z.literal("v1"),
  buildSha: z.string(),
  generatedAt: z.string(),
  /** Irreducible session contract — code-owned, survives an empty/down hub. */
  toolingInvariants: z.array(z.string()),
  /** Live from the hub: the governing index (`KnowledgeStorePort.listGoverningIndex`), index only. */
  governingIndex: z.array(CognitionGoverningPointerSchema),
  /**
   * How `markdown` rendered the governing index: `whole-index` (every row
   * inline) or `shelf-pointer` (the `method` shelf inline plus a pull pointer),
   * and the UTF-8 bytes the whole-index render takes. The routing eval reads
   * this for its bundle-size row (WHOLE_BUNDLE_BUDGET_64KIB).
   */
  governingRender: z.object({
    mode: z.enum(["whole-index", "shelf-pointer"]),
    wholeBytes: z.number().int(),
  }),
  /** Live from the hub: registered domains the agent should RECALL first. */
  domainPointers: z.array(CognitionDomainPointerSchema),
  /** Recall + contribute pointers (paths, not bodies). */
  recallProtocol: z.string(),
  /**
   * Fully-rendered GFM bundle. A SessionStart hook echoes this verbatim to
   * stdout (Claude Code + Codex both inject SessionStart stdout into context).
   */
  markdown: z.string(),
});
export type CognitionBundleResponse = z.infer<
  typeof CognitionBundleResponseSchema
>;
