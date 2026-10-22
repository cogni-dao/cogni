// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/write-replay`
 * Purpose: Compare successful request replays using durable row and edge identity.
 * Scope: Pure domain validation. Does not compare generated timestamps or policy confidence.
 * Invariants: Same identity with different content fails explicitly; no callback replay guarantee is implied.
 * Side-effects: none
 * Links: knowledge-store.port.ts
 * @internal
 */
import { stripDangerousControlChars } from "./sanitize.js";
import type { Citation, Knowledge, NewKnowledge } from "./schemas.js";

export class KnowledgeWriteConflictError extends Error {
  get receipt() {
    return {
      code: "knowledge_write_conflict",
      retryable: false as const,
      lookup: { entryId: this.entryId },
    };
  }
  constructor(readonly entryId: string) {
    super(
      `Knowledge ${entryId} already has different content; use an explicit reviewed update instead of replaying a stale write.`
    );
    this.name = "KnowledgeWriteConflictError";
  }
}

export function assertKnowledgeReplay(
  existing: Knowledge,
  input: NewKnowledge
): void {
  const normalize = (entry: Knowledge | NewKnowledge) => ({
    id: entry.id,
    domain: entry.domain,
    entityId: entry.entityId ?? null,
    title: stripDangerousControlChars(entry.title),
    content: stripDangerousControlChars(entry.content),
    useWhen: entry.useWhen ? stripDangerousControlChars(entry.useWhen) : null,
    entryType: entry.entryType ?? "finding",
    sourceType: entry.sourceType,
    sourceRef: entry.sourceRef ?? null,
    tags: entry.tags ?? null,
    evaluateAt: entry.evaluateAt
      ? new Date(entry.evaluateAt).toISOString()
      : null,
    resolutionStrategy: entry.resolutionStrategy ?? null,
  });
  if (JSON.stringify(normalize(existing)) !== JSON.stringify(normalize(input)))
    throw new KnowledgeWriteConflictError(input.id);
}

/** Edge identity is part of an EDO request, independently of generated citation IDs. */
export function assertCitationReplay(
  entryId: string,
  actual: readonly Citation[],
  citationType: string,
  expectedTargets: readonly string[]
): void {
  const found = [
    ...new Set(
      actual
        .filter((edge) => edge.citationType === citationType)
        .map((edge) => edge.citedId)
    ),
  ].sort();
  const expected = [...new Set(expectedTargets)].sort();
  if (JSON.stringify(found) !== JSON.stringify(expected))
    throw new KnowledgeWriteConflictError(entryId);
}
