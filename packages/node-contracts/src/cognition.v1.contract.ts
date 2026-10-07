// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/cognition.v1.contract`
 * Purpose: HTTP response contract for a node's session-start cognition substrate bundle.
 *   Served at GET /api/v1/cognition (advertised via /.well-known/agent.json) in place of
 *   git-synced AGENTS.md sprawl.
 * Scope: Zod schemas + types for the wire format only. Does not contain business logic, I/O, or auth.
 * Invariants:
 *   - INDEX_NOT_CONTENT: bundle carries skill/domain POINTERS (id + title +
 *     recall path) — discovery metadata only, never entry bodies or excerpts.
 *     Full content stays behind the authed read routes
 *     (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: `toolingInvariants` + `markdown`
 *     render even when the hub is empty or unreachable, so a session always
 *     bootstraps.
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { z } from "zod";

export const CognitionSkillPointerSchema = z.object({
  id: z.string(),
  /** The entry's claim, in one line. Discovery metadata, not body. */
  title: z.string(),
  /**
   * The entry's retrieval trigger — the reader's situation, from the
   * `use_when` column. Null on entries written before the column existed, or
   * on types that legitimately have none (hypothesis/decision/html). Renderers
   * fall back to `title` so an un-backfilled node still shows something.
   */
  useWhen: z.string().nullable().optional(),
  entryType: z.string(),
  domain: z.string(),
});
export type CognitionSkillPointer = z.infer<typeof CognitionSkillPointerSchema>;

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
  /** Live from the hub: cognition entries (skill/guide/playbook), index only. */
  skillsIndex: z.array(CognitionSkillPointerSchema),
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
