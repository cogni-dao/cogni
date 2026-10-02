// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_skills-index`
 * Purpose: Load the complete cross-domain actionable knowledge index for the cognition bundle.
 * Scope: Pure mapping over an injected knowledge read port. No env, auth, or rendering.
 * Invariants: ACTIONABLE_INDEX_IS_UNBOUNDED_BY_DOMAIN_PAGE — skill/guide/playbook
 *   retrieval never depends on the bounded per-domain browse scan.
 * Side-effects: IO through the injected read port.
 * Links: bug.5350, docs/spec/node-baas-architecture.md
 * @internal
 */

import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import type { CognitionSkillPointer } from "@cogni/node-contracts";

export const COGNITION_SKILL_ENTRY_TYPES = [
  "skill",
  "guide",
  "playbook",
] as const;

type SkillsIndexPort = Pick<KnowledgeStorePort, "listKnowledgeByEntryTypes">;

/** Load every actionable pointer with one dedicated query across all domains. */
export async function loadCognitionSkillsIndex(
  port: SkillsIndexPort
): Promise<CognitionSkillPointer[]> {
  const rows = await port.listKnowledgeByEntryTypes(
    COGNITION_SKILL_ENTRY_TYPES
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    entryType: row.entryType,
    domain: row.domain,
  }));
}
