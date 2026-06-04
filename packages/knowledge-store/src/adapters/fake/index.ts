// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/fake`
 * Purpose: In-memory FakeKnowledgeStoreAdapter and FakeEdoResolverAdapter for unit and integration tests.
 * Scope: Test double only. Enforces the same adapter-layer invariants as DoltgresKnowledgeStoreAdapter (HYPOTHESIS_HAS_EVALUATE_AT, CITATION_TARGET_EXISTS_AT_WRITE, EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE, DOMAIN_FK_ENFORCED_AT_WRITE). NOT used in production.
 * Invariants: parity with DoltgresKnowledgeStoreAdapter on all enforcement gates.
 * Side-effects: none (in-memory maps only)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  Citation,
  CitationType,
  DoltCommit,
  DoltDiffEntry,
  Knowledge,
  NewCitation,
  NewKnowledge,
} from "../../domain/schemas.js";
import { HYPOTHESIS_TARGETED_EDGES } from "../../domain/schemas.js";
import type {
  ChainNode,
  EdoResolverPort,
  PendingResolutionsOptions,
  ResolutionInput,
  ResolutionResult,
  WalkChainOptions,
} from "../../port/edo-resolver.port.js";
import {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  type Domain,
  DomainAlreadyRegisteredError,
  DomainNotRegisteredError,
  HypothesisMissingEvaluateAtError,
  type KnowledgeStorePort,
  type NewDomain,
} from "../../port/knowledge-store.port.js";

// ---------------------------------------------------------------------------
// Confidence formula (mirrors DoltgresEdoResolverAdapter)
// ---------------------------------------------------------------------------

const SUPPORT_BUMP = 10;
const SUPPORT_CAP = 50;
const CONTRADICT_PENALTY = 15;
const WALK_CHAIN_DEFAULT_DEPTH = 5;
const WALK_CHAIN_MAX_DEPTH = 10;
const INITIAL_BY_SOURCE: Record<string, number> = {
  agent: 30,
  analysis_signal: 40,
  external: 50,
  human: 70,
  derived: 40,
};
const INITIAL_DEFAULT = 40;

function isSupporting(t: CitationType): boolean {
  return (
    t === "supports" ||
    t === "validates" ||
    t === "evidence_for" ||
    t === "extends"
  );
}

function isContradicting(t: CitationType): boolean {
  return t === "contradicts" || t === "invalidates";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function expectedEntryTypeForEdge(t: CitationType): string | null {
  return HYPOTHESIS_TARGETED_EDGES.includes(t) ? "hypothesis" : null;
}

function citationId(
  citingId: string,
  citedId: string,
  type: CitationType
): string {
  return `${citingId}->${citedId}:${type}`;
}

// ---------------------------------------------------------------------------
// FakeKnowledgeStoreAdapter — implements KnowledgeStorePort over in-memory maps
// ---------------------------------------------------------------------------

export class FakeKnowledgeStoreAdapter implements KnowledgeStorePort {
  private readonly rows = new Map<string, Knowledge>();
  private readonly edges = new Map<string, Citation>();
  private readonly domainsMap = new Map<string, Domain>();
  /** Append-only history of commit messages for assertions. */
  readonly commitLog: Array<{ hash: string; message: string; at: Date }> = [];
  private commitCounter = 0;

  // --- Read ---

  async getKnowledge(id: string): Promise<Knowledge | null> {
    return this.rows.get(id) ?? null;
  }

  async listKnowledge(
    domain: string,
    opts?: { tags?: string[]; limit?: number }
  ): Promise<Knowledge[]> {
    let out = Array.from(this.rows.values()).filter((r) => r.domain === domain);
    if (opts?.tags?.length) {
      const wanted = new Set(opts.tags);
      out = out.filter((r) => (r.tags ?? []).some((t) => wanted.has(t)));
    }
    out.sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }

  async searchKnowledge(
    domain: string,
    query: string,
    opts?: { limit?: number }
  ): Promise<Knowledge[]> {
    const q = query.toLowerCase();
    const out = Array.from(this.rows.values()).filter(
      (r) =>
        r.domain === domain &&
        (r.title.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q))
    );
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }

  async listDomains(): Promise<string[]> {
    return Array.from(
      new Set(Array.from(this.rows.values()).map((r) => r.domain))
    ).sort();
  }

  // --- Domain registry ---

  async domainExists(id: string): Promise<boolean> {
    return this.domainsMap.has(id);
  }

  async listDomainsFull(): Promise<Domain[]> {
    return Array.from(this.domainsMap.values()).map((d) => ({
      ...d,
      entryCount: Array.from(this.rows.values()).filter(
        (r) => r.domain === d.id
      ).length,
    }));
  }

  async registerDomain(input: NewDomain): Promise<Domain> {
    if (this.domainsMap.has(input.id)) {
      throw new DomainAlreadyRegisteredError(input.id);
    }
    const row: Domain = {
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      confidencePct: 40,
      entryCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.domainsMap.set(input.id, row);
    this.commitLog.push({
      hash: this.nextHash(),
      message: `register domain ${input.id}`,
      at: new Date(),
    });
    return row;
  }

  // --- Write — rows ---

  async upsertKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    if (!this.domainsMap.has(entry.domain)) {
      throw new DomainNotRegisteredError(entry.domain);
    }
    if (entry.entryType === "hypothesis" && !entry.evaluateAt) {
      throw new HypothesisMissingEvaluateAtError(entry.id);
    }
    const existing = this.rows.get(entry.id);
    const row: Knowledge = {
      id: entry.id,
      domain: entry.domain,
      entityId: entry.entityId ?? null,
      title: entry.title,
      content: entry.content,
      entryType: entry.entryType ?? "finding",
      confidencePct: entry.confidencePct ?? null,
      sourceType: entry.sourceType,
      sourceRef: entry.sourceRef ?? null,
      tags: entry.tags ?? null,
      evaluateAt: entry.evaluateAt ?? null,
      resolutionStrategy: entry.resolutionStrategy ?? null,
      createdAt: existing?.createdAt ?? new Date(),
    };
    this.rows.set(entry.id, row);
    return row;
  }

  async addKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    if (!this.domainsMap.has(entry.domain)) {
      throw new DomainNotRegisteredError(entry.domain);
    }
    if (entry.entryType === "hypothesis" && !entry.evaluateAt) {
      throw new HypothesisMissingEvaluateAtError(entry.id);
    }
    if (this.rows.has(entry.id)) {
      throw new Error(`duplicate key: knowledge.id='${entry.id}'`);
    }
    return this.upsertKnowledge(entry);
  }

  async updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`Knowledge ${id} not found`);
    if (update.domain && !this.domainsMap.has(update.domain)) {
      throw new DomainNotRegisteredError(update.domain);
    }
    const merged: Knowledge = {
      ...existing,
      ...(update.domain !== undefined && { domain: update.domain }),
      ...(update.entityId !== undefined && { entityId: update.entityId }),
      ...(update.title !== undefined && { title: update.title }),
      ...(update.content !== undefined && { content: update.content }),
      ...(update.entryType !== undefined && { entryType: update.entryType }),
      ...(update.confidencePct !== undefined && {
        confidencePct: update.confidencePct,
      }),
      ...(update.sourceType !== undefined && { sourceType: update.sourceType }),
      ...(update.sourceRef !== undefined && { sourceRef: update.sourceRef }),
      ...(update.tags !== undefined && { tags: update.tags }),
      ...(update.evaluateAt !== undefined && { evaluateAt: update.evaluateAt }),
      ...(update.resolutionStrategy !== undefined && {
        resolutionStrategy: update.resolutionStrategy,
      }),
    };
    this.rows.set(id, merged);
    return merged;
  }

  async deleteKnowledge(id: string): Promise<void> {
    this.rows.delete(id);
  }

  // --- Knowledge identity ---

  async getKnowledgeEntryType(id: string): Promise<string | null> {
    return this.rows.get(id)?.entryType ?? null;
  }

  async knowledgeExists(id: string): Promise<boolean> {
    return this.rows.has(id);
  }

  // --- Write — edges ---

  async addCitation(edge: NewCitation): Promise<Citation> {
    const citedRow = this.rows.get(edge.citedId);
    if (!citedRow) {
      throw new CitationTargetNotFoundError(edge.citedId);
    }
    const expected = expectedEntryTypeForEdge(edge.citationType);
    if (expected !== null && citedRow.entryType !== expected) {
      throw new CitationTypeMismatchError(
        edge.citationType,
        edge.citedId,
        citedRow.entryType ?? "(none)",
        expected
      );
    }
    const id =
      edge.id ?? citationId(edge.citingId, edge.citedId, edge.citationType);
    // Idempotent on the unique tuple.
    const existing = this.edges.get(id);
    if (existing) return existing;
    const row: Citation = {
      id,
      citingId: edge.citingId,
      citedId: edge.citedId,
      citationType: edge.citationType,
      context: edge.context ?? null,
      createdAt: new Date(),
    };
    this.edges.set(id, row);
    return row;
  }

  async listCitationsByCitingId(citingId: string): Promise<Citation[]> {
    return Array.from(this.edges.values()).filter(
      (c) => c.citingId === citingId
    );
  }

  async listCitationsByCitedId(citedId: string): Promise<Citation[]> {
    return Array.from(this.edges.values()).filter((c) => c.citedId === citedId);
  }

  // --- Doltgres versioning (stubbed) ---

  async commit(message: string): Promise<string> {
    const hash = this.nextHash();
    this.commitLog.push({ hash, message, at: new Date() });
    return hash;
  }

  async log(limit?: number): Promise<DoltCommit[]> {
    const out = [...this.commitLog].reverse().map((c) => ({
      commitHash: c.hash,
      committer: "fake",
      email: "fake@cogni.test",
      date: c.at,
      message: c.message,
    }));
    return limit ? out.slice(0, limit) : out;
  }

  async diff(_fromRef: string, _toRef: string): Promise<DoltDiffEntry[]> {
    return [];
  }

  async currentCommit(): Promise<string> {
    return this.commitLog.at(-1)?.hash ?? "0000000";
  }

  private nextHash(): string {
    this.commitCounter++;
    return `fake${String(this.commitCounter).padStart(3, "0")}`;
  }
}

// ---------------------------------------------------------------------------
// FakeEdoResolverAdapter — mirrors DoltgresEdoResolverAdapter semantics
// ---------------------------------------------------------------------------

export class FakeEdoResolverAdapter implements EdoResolverPort {
  constructor(private readonly store: FakeKnowledgeStoreAdapter) {}

  async pendingResolutions(
    now: Date,
    opts?: PendingResolutionsOptions
  ): Promise<Knowledge[]> {
    const limit = opts?.limit ?? 100;
    const strategy = opts?.strategy;
    // Hypotheses that are due, have a non-null strategy, and not yet resolved.
    const all = await this.store.listDomains();
    const candidates: Knowledge[] = [];
    for (const d of all) {
      const rows = await this.store.listKnowledge(d, { limit: 10_000 });
      for (const r of rows) {
        if (r.entryType !== "hypothesis") continue;
        if (!r.resolutionStrategy) continue;
        if (!r.evaluateAt) continue;
        if (r.evaluateAt.getTime() > now.getTime()) continue;
        if (strategy !== undefined) {
          if (strategy.endsWith(":")) {
            if (!r.resolutionStrategy.startsWith(strategy)) continue;
          } else if (r.resolutionStrategy !== strategy) {
            continue;
          }
        }
        const incoming = await this.store.listCitationsByCitedId(r.id);
        const isResolved = incoming.some(
          (c) =>
            c.citationType === "validates" || c.citationType === "invalidates"
        );
        if (isResolved) continue;
        candidates.push(r);
      }
    }
    candidates.sort(
      (a, b) => (a.evaluateAt?.getTime() ?? 0) - (b.evaluateAt?.getTime() ?? 0)
    );
    return candidates.slice(0, limit);
  }

  async resolveHypothesis(input: ResolutionInput): Promise<ResolutionResult> {
    const incoming = await this.store.listCitationsByCitedId(
      input.hypothesisId
    );
    const existing = incoming.find(
      (c) => c.citationType === "validates" || c.citationType === "invalidates"
    );
    if (existing) {
      const confidence = await this.recomputeConfidence(input.hypothesisId);
      return {
        // Return the EXISTING outcome row's id, not the caller's proposed id.
        // The caller may have passed a different id on retry; idempotency
        // is keyed on the hypothesis, not the proposed outcome.
        outcomeId: existing.citingId,
        citationId: existing.id,
        resolvedConfidence: confidence,
        alreadyResolved: true,
      };
    }

    const outcome = await this.store.addKnowledge({
      id: input.outcomeId,
      domain: input.domain,
      title: input.outcomeTitle,
      content: input.outcomeContent,
      entryType: "outcome",
      sourceType: input.sourceType,
      sourceRef: input.sourceRef ?? null,
    });

    const citation = await this.store.addCitation({
      citingId: outcome.id,
      citedId: input.hypothesisId,
      citationType: input.edge,
      context: `resolved by ${input.sourceType}`,
    });

    const resolvedConfidence = await this.recomputeConfidence(
      input.hypothesisId
    );

    await this.store.commit(
      `edo: resolve hypothesis ${input.hypothesisId} (${input.edge}, conf: ${resolvedConfidence}%)`
    );

    return {
      outcomeId: outcome.id,
      citationId: citation.id,
      resolvedConfidence,
      alreadyResolved: false,
    };
  }

  async recomputeConfidence(entryId: string): Promise<number> {
    const entry = await this.store.getKnowledge(entryId);
    if (!entry) {
      throw new Error(`recomputeConfidence: entry '${entryId}' not found`);
    }
    const incoming = await this.store.listCitationsByCitedId(entryId);
    const initial = INITIAL_BY_SOURCE[entry.sourceType] ?? INITIAL_DEFAULT;
    let supportCount = 0;
    let contradictCount = 0;
    for (const c of incoming) {
      if (isSupporting(c.citationType)) supportCount++;
      else if (isContradicting(c.citationType)) contradictCount++;
    }
    const next = clamp(
      initial +
        Math.min(SUPPORT_CAP, SUPPORT_BUMP * supportCount) -
        CONTRADICT_PENALTY * contradictCount
    );
    await this.store.updateKnowledge(entryId, { confidencePct: next });
    return next;
  }

  async walkChain(
    rootId: string,
    opts?: WalkChainOptions
  ): Promise<ChainNode[]> {
    const direction = opts?.direction ?? "both";
    const requested = opts?.maxDepth ?? WALK_CHAIN_DEFAULT_DEPTH;
    const maxDepth = Math.min(Math.max(0, requested), WALK_CHAIN_MAX_DEPTH);
    const root = await this.store.getKnowledge(rootId);
    if (!root) return [];

    const visited = new Set<string>([rootId]);
    const out: ChainNode[] = [{ entry: root, depth: 0, edgeFromParent: null }];
    let frontier: Array<{ id: string; depth: number }> = [
      { id: rootId, depth: 0 },
    ];

    while (frontier.length > 0) {
      const next: Array<{ id: string; depth: number }> = [];
      for (const node of frontier) {
        if (node.depth >= maxDepth) continue;
        const childDepth = node.depth + 1;
        if (direction === "out" || direction === "both") {
          // citing→cited: this node CITES X
          const outgoing = await this.store.listCitationsByCitingId(node.id);
          for (const c of outgoing) {
            if (visited.has(c.citedId)) continue;
            const child = await this.store.getKnowledge(c.citedId);
            if (!child) continue;
            visited.add(c.citedId);
            out.push({
              entry: child,
              depth: childDepth,
              edgeFromParent: {
                citationType: c.citationType,
                direction: "out",
              },
            });
            next.push({ id: c.citedId, depth: childDepth });
          }
        }
        if (direction === "in" || direction === "both") {
          // cited→citing: X CITES this node
          const incoming = await this.store.listCitationsByCitedId(node.id);
          for (const c of incoming) {
            if (visited.has(c.citingId)) continue;
            const child = await this.store.getKnowledge(c.citingId);
            if (!child) continue;
            visited.add(c.citingId);
            out.push({
              entry: child,
              depth: childDepth,
              edgeFromParent: {
                citationType: c.citationType,
                direction: "in",
              },
            });
            next.push({ id: c.citingId, depth: childDepth });
          }
        }
      }
      frontier = next;
    }

    return out;
  }
}
