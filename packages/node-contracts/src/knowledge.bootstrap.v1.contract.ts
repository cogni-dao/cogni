// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.bootstrap.v1.contract`
 * Purpose: HTTP response contract for the session-start kickstart bundle —
 *   the "cognition substrate" a node serves to an agent at SessionStart in
 *   place of git-synced AGENTS.md sprawl. Mounted at
 *   GET /api/v1/knowledge/bootstrap and advertised via /.well-known/agent.json.
 * Scope: Zod schemas + types for the wire format. No business logic, I/O, or auth.
 * Invariants:
 *   - INDEX_NOT_CONTENT: bundle carries skill/domain POINTERS (title + use-when
 *     + recall path), never full entry bodies — full content stays behind the
 *     authed read routes (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: `toolingInvariants` + `markdown`
 *     render even when the hub is empty or unreachable, so a session always
 *     bootstraps.
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { z } from "zod";

export const BootstrapSkillPointerSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** "use when X" framing lifted from the entry — the recall decision line. */
  useWhen: z.string(),
  entryType: z.string(),
  domain: z.string(),
});
export type BootstrapSkillPointer = z.infer<typeof BootstrapSkillPointerSchema>;

export const BootstrapDomainPointerSchema = z.object({
  domain: z.string(),
  description: z.string().nullable(),
  entryCount: z.number().int(),
});
export type BootstrapDomainPointer = z.infer<
  typeof BootstrapDomainPointerSchema
>;

export const KnowledgeBootstrapResponseSchema = z.object({
  node: z.string(),
  version: z.literal("v1"),
  buildSha: z.string(),
  generatedAt: z.string(),
  /** Irreducible session contract — code-owned, survives an empty/down hub. */
  toolingInvariants: z.array(z.string()),
  /** Live from the hub: cognition entries (skill/guide/playbook), index only. */
  skillsIndex: z.array(BootstrapSkillPointerSchema),
  /** Live from the hub: registered domains the agent should RECALL first. */
  domainPointers: z.array(BootstrapDomainPointerSchema),
  /** Recall + contribute pointers (paths, not bodies). */
  recallProtocol: z.string(),
  /**
   * Fully-rendered GFM bundle. A SessionStart hook echoes this verbatim to
   * stdout (Claude Code + Codex both inject SessionStart stdout into context).
   */
  markdown: z.string(),
});
export type KnowledgeBootstrapResponse = z.infer<
  typeof KnowledgeBootstrapResponseSchema
>;
