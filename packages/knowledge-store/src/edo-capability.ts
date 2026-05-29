// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/edo-capability`
 * Purpose: Factory that wraps KnowledgeStorePort and EdoResolverPort as an EdoCapability with auto-commit on every write.
 * Scope: Pure mapping + composition. Does not load env vars or manage lifecycle.
 * Invariants:
 *   - EDO_TOOLS_ATOMIC: each method writes entry + edges + commit in one call.
 *   - AUTO_COMMIT_ON_WRITE: every write triggers one dolt_commit.
 *   - RESOLVER_IDEMPOTENT (recordOutcome): double-firing returns existing state.
 * Side-effects: none (delegates I/O to ports)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  ChainNodeEntry,
  DecideParams,
  EdoCapability,
  GetChainParams,
  GetChainResult,
  HypothesizeParams,
  KnowledgeEntry,
  RecordOutcomeParams,
  RecordOutcomeResult,
} from "@cogni/ai-tools";

import type { EdoResolverPort } from "./port/edo-resolver.port.js";
import type { KnowledgeStorePort } from "./port/knowledge-store.port.js";

const CONFIDENCE_AGENT_DEFAULT = 30;

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

/**
 * Create an EdoCapability backed by KnowledgeStorePort + EdoResolverPort.
 * Each method writes entry + edges + commit atomically (one commit per call).
 *
 * `recordOutcome` additionally calls `EdoResolverPort.resolveHypothesis`,
 * which writes the outcome + citation + recomputes confidence on the
 * hypothesis. Idempotent on already-resolved hypotheses.
 */
export function createEdoCapability(
  store: KnowledgeStorePort,
  resolver: EdoResolverPort
): EdoCapability {
  return {
    async hypothesize(params: HypothesizeParams): Promise<KnowledgeEntry> {
      // 1. Write the hypothesis row. Adapter enforces HYPOTHESIS_HAS_EVALUATE_AT.
      const entry = await store.addKnowledge({
        id: params.id,
        domain: params.domain,
        title: params.title,
        content: params.content,
        entryType: "hypothesis",
        confidencePct: params.confidencePct ?? CONFIDENCE_AGENT_DEFAULT,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef ?? null,
        tags: params.tags ?? null,
        evaluateAt: params.evaluateAt,
        resolutionStrategy: params.resolutionStrategy ?? null,
      });

      // 2. Write evidence_for edges (if any).
      for (const evidenceId of params.evidenceForIds ?? []) {
        await store.addCitation({
          citingId: params.id,
          citedId: evidenceId,
          citationType: "evidence_for",
        });
      }

      // 3. One commit per hypothesize call.
      await store.commit(
        `edo: hypothesize '${params.id}' (resolve: ${params.resolutionStrategy ?? "manual"})`
      );

      return toEntry(entry);
    },

    async decide(params: DecideParams): Promise<KnowledgeEntry> {
      // 1. Write the decision row.
      const entry = await store.addKnowledge({
        id: params.id,
        domain: params.domain,
        title: params.title,
        content: params.content,
        entryType: "decision",
        confidencePct: params.confidencePct ?? CONFIDENCE_AGENT_DEFAULT,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef ?? null,
        tags: params.tags ?? null,
      });

      // 2. Write derives_from edge. Adapter enforces
      //    CITATION_TARGET_EXISTS_AT_WRITE + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE
      //    (the cited row must be entry_type='hypothesis').
      await store.addCitation({
        citingId: params.id,
        citedId: params.derivesFromHypothesisId,
        citationType: "derives_from",
      });

      await store.commit(
        `edo: decide '${params.id}' from '${params.derivesFromHypothesisId}'`
      );

      return toEntry(entry);
    },

    async recordOutcome(
      params: RecordOutcomeParams
    ): Promise<RecordOutcomeResult> {
      // resolveHypothesis writes outcome + citation + recomputes confidence +
      // commits — all enforced through the same port.
      const result = await resolver.resolveHypothesis({
        hypothesisId: params.hypothesisId,
        domain: params.domain,
        outcomeId: params.id,
        outcomeTitle: params.title,
        outcomeContent: params.content,
        edge: params.edge,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef ?? null,
        sourceNode: params.sourceNode ?? null,
      });

      const outcome = await store.getKnowledge(result.outcomeId);
      if (!outcome) {
        throw new Error(
          `recordOutcome: outcome row '${result.outcomeId}' missing after resolve`
        );
      }

      return {
        outcome: toEntry(outcome),
        hypothesisId: params.hypothesisId,
        resolvedConfidence: result.resolvedConfidence,
        citationId: result.citationId,
        alreadyResolved: result.alreadyResolved,
      };
    },

    async getChain(params: GetChainParams): Promise<GetChainResult> {
      const walkOpts: { direction?: "out" | "in" | "both"; maxDepth?: number } =
        {};
      if (params.direction !== undefined) walkOpts.direction = params.direction;
      if (params.maxDepth !== undefined) walkOpts.maxDepth = params.maxDepth;
      const nodes = await resolver.walkChain(params.rootId, walkOpts);
      const [firstNode] = nodes;
      if (!firstNode) {
        throw new Error(`getChain: root entry '${params.rootId}' not found`);
      }
      const chain: ChainNodeEntry[] = nodes.map((n) => ({
        entry: toEntry(n.entry),
        depth: n.depth,
        edgeFromParent: n.edgeFromParent
          ? {
              citationType: n.edgeFromParent.citationType,
              direction: n.edgeFromParent.direction,
            }
          : null,
      }));
      return { root: toEntry(firstNode.entry), chain };
    },
  };
}
