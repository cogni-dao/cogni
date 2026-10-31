// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/capability`
 * Purpose: Factory that wraps KnowledgeStorePort as a KnowledgeCapability with auto-commit on writes and the governing index read.
 * Scope: Pure mapping logic. Does not load env vars or manage lifecycle.
 * Invariants:
 *   - AUTO_COMMIT: Every write() call upserts + commits automatically.
 *   - PACKAGES_NO_ENV: Connection is injected, never from process.env.
 * Side-effects: none (delegates I/O to port)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import type {
  GoverningIndexEntry,
  KnowledgeCapability,
  KnowledgeEntry,
  KnowledgeListParams,
  KnowledgeSearchParams,
  KnowledgeWriteParams,
} from "@cogni/ai-tools";
import { toKnowledgeRow as toEntry } from "@cogni/shared-knowledge-store";
import { initializeConfidence } from "./domain/confidence-policy.js";
import {
  type KnowledgeGate,
  KnowledgeGateError,
  runGateChain,
  V0_DETERMINISTIC_GATES,
} from "./domain/gates/index.js";
import { KnowledgeWriteConflictError } from "./domain/write-replay.js";
import type { KnowledgeStorePort } from "./port/knowledge-store.port.js";

export interface KnowledgeCapabilityOptions {
  /**
   * Write-pipeline gates run before every write. v0 = shape + provenance
   * (see proj.knowledge-syntropy W0 tier). Pass `[]` to disable (don't, except
   * in unit tests that exercise the port directly).
   *
   * @default V0_DETERMINISTIC_GATES
   */
  readonly gates?: readonly KnowledgeGate[];
}

/**
 * Create a KnowledgeCapability backed by a KnowledgeStorePort.
 * Shared across all nodes — lives in packages/knowledge-store, not per-node bootstrap.
 *
 * - Read operations delegate directly to the port.
 * - write() runs the v0 gate chain, then upserts + auto-commits with a
 *   descriptive message. A failing gate throws `KnowledgeGateError` — the
 *   write is rejected at the seam, never reaches Doltgres.
 * - Confidence is initialized by the shared domain policy if not specified.
 */
export function createKnowledgeCapability(
  port: KnowledgeStorePort,
  options: KnowledgeCapabilityOptions = {}
): KnowledgeCapability {
  const gates = options.gates ?? V0_DETERMINISTIC_GATES;

  return {
    async search(params: KnowledgeSearchParams): Promise<KnowledgeEntry[]> {
      const results = await port.searchKnowledge(params.domain, params.query, {
        limit: params.limit,
        ...(params.includeEdo ? { includeEdo: true } : {}),
      });
      return results.map(toEntry);
    },

    async list(params: KnowledgeListParams): Promise<KnowledgeEntry[]> {
      const results = await port.listKnowledge(params.domain, {
        tags: params.tags,
        limit: params.limit,
        ...(params.includeEdo ? { includeEdo: true } : {}),
      });
      return results.map(toEntry);
    },

    async get(id: string): Promise<KnowledgeEntry | null> {
      const result = await port.getKnowledge(id);
      return result ? toEntry(result) : null;
    },

    // ONE_SOURCE_SEPARATE_ADAPTERS: the same governing rows the session bundle
    // renders, for core__knowledge_index. No filtering or re-ranking here.
    async listGoverningIndex(): Promise<GoverningIndexEntry[]> {
      return port.listGoverningIndex();
    },

    async write(params: KnowledgeWriteParams): Promise<KnowledgeEntry> {
      const gateResult = await runGateChain(
        gates,
        {
          id: params.id,
          domain: params.domain,
          title: params.title,
          content: params.content,
          sourceType: params.sourceType,
          sourceRef: params.sourceRef,
          entityId: params.entityId,
          tags: params.tags,
        },
        {}
      );
      if (!gateResult.ok) {
        throw new KnowledgeGateError(gateResult.errors);
      }
      // Gates may sanitize but never widen sourceType beyond what the caller
      // passed (the shape/provenance v0 gates only touch title/tags/etc), so
      // the original enum-typed value is the safe carrier.
      const c = gateResult.candidate;
      const confidence = initializeConfidence({
        sourceType: params.sourceType,
      });
      return port.withWrite(
        {
          operationId: `knowledge.write:${c.id ?? params.id}`,
          message: `knowledge: ${params.sourceType} — ${c.title}`,
        },
        async (write) => {
          const previous = await write.getKnowledge(c.id ?? params.id);
          if (previous) {
            const key = (edge: {
              citedId: string;
              citationType: string;
              context?: string | null;
            }) =>
              JSON.stringify([
                edge.citedId,
                edge.citationType,
                edge.context ?? null,
              ]);
            const expected = [
              ...new Set((params.citations ?? []).map(key)),
            ].sort();
            const actual = [
              ...new Set(
                (await write.listCitationsByCitingId(previous.id)).map(key)
              ),
            ].sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              throw new KnowledgeWriteConflictError(previous.id);
          }
          const entry = await write.upsertKnowledge({
            id: c.id ?? params.id,
            domain: c.domain,
            title: c.title,
            content: c.content,
            sourceType: params.sourceType,
            entityId: c.entityId ?? null,
            confidencePct: confidence.confidencePct,
            sourceRef: c.sourceRef ?? null,
            tags: c.tags ?? null,
          });

          // Outgoing edges land in the SAME auto-commit as the entry. The port
          // enforces CITATION_TARGET_EXISTS + EDGE_TYPE_MATCHES (a no-op for these
          // non-hypothesis edges). Confidence recompute on the cited rows is the
          // resolver's job, not inlined here.
          for (const cite of params.citations ?? []) {
            await write.addCitation({
              citingId: entry.id,
              citedId: cite.citedId,
              citationType: cite.citationType,
              context: cite.context ?? null,
            });
          }

          return toEntry(entry);
        }
      );
    },
  };
}
