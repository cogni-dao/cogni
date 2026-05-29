// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/capability`
 * Purpose: Factory that wraps KnowledgeStorePort as a KnowledgeCapability with auto-commit on writes.
 * Scope: Pure mapping logic. Does not load env vars or manage lifecycle.
 * Invariants:
 *   - AUTO_COMMIT: Every write() call upserts + commits automatically.
 *   - PACKAGES_NO_ENV: Connection is injected, never from process.env.
 * Side-effects: none (delegates I/O to port)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import type {
  KnowledgeCapability,
  KnowledgeEntry,
  KnowledgeListParams,
  KnowledgeSearchParams,
  KnowledgeWriteParams,
} from "@cogni/ai-tools";

import {
  type KnowledgeGate,
  KnowledgeGateError,
  runGateChain,
  V0_DETERMINISTIC_GATES,
} from "./domain/gates/index.js";
import type { KnowledgeStorePort } from "./port/knowledge-store.port.js";

const CONFIDENCE_DRAFT = 30;

function toEntry(k: {
  id: string;
  domain: string;
  entityId?: string | null;
  title: string;
  content: string;
  confidencePct?: number | null;
  sourceType: string;
  sourceRef?: string | null;
  tags?: string[] | null;
}): KnowledgeEntry {
  return {
    id: k.id,
    domain: k.domain,
    entityId: k.entityId ?? null,
    title: k.title,
    content: k.content,
    confidencePct: k.confidencePct ?? null,
    sourceType: k.sourceType,
    sourceRef: k.sourceRef ?? null,
    tags: k.tags ?? null,
  };
}

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
 * - Confidence defaults to DRAFT (30%) if not specified.
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
      });
      return results.map(toEntry);
    },

    async list(params: KnowledgeListParams): Promise<KnowledgeEntry[]> {
      const results = await port.listKnowledge(params.domain, {
        tags: params.tags,
        limit: params.limit,
      });
      return results.map(toEntry);
    },

    async get(id: string): Promise<KnowledgeEntry | null> {
      const result = await port.getKnowledge(id);
      return result ? toEntry(result) : null;
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
      const confidence = params.confidencePct ?? CONFIDENCE_DRAFT;
      const entry = await port.upsertKnowledge({
        id: c.id ?? params.id,
        domain: c.domain,
        title: c.title,
        content: c.content,
        sourceType: params.sourceType,
        entityId: c.entityId ?? null,
        confidencePct: confidence,
        sourceRef: c.sourceRef ?? null,
        tags: c.tags ?? null,
      });

      await port.commit(`knowledge: ${entry.sourceType} — ${entry.title}`);
      return toEntry(entry);
    },
  };
}
