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

import {
  initializeConfidence,
  isConfidenceExempt,
  recomputeConfidence as recomputeConfidenceByPolicy,
} from "../../domain/confidence-policy.js";
import { type ActiveGoal, selectActiveGoals } from "../../domain/dao-goals.js";
import { stripDangerousControlChars } from "../../domain/sanitize.js";
import type {
  Citation,
  CitationType,
  DoltCommit,
  DoltDiffEntry,
  Knowledge,
  NewCitation,
  NewKnowledge,
} from "../../domain/schemas.js";
import {
  citedEntryTypesFor,
  HYPOTHESIS_TARGETED_EDGES,
  isEdoEntryType,
  isWorkItemEndpointId,
  requiresEvaluateAt,
} from "../../domain/schemas.js";
import {
  assertKnowledgeReplay,
  KnowledgeWriteConflictError,
} from "../../domain/write-replay.js";
import type {
  ChainNode,
  EdoResolverPort,
  PendingResolutionsOptions,
  ResolutionInput,
  ResolutionResult,
  WalkChainOptions,
} from "../../port/edo-resolver.port.js";
import {
  type CitationLinkPage,
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  type Domain,
  DomainAlreadyRegisteredError,
  DomainNotRegisteredError,
  HypothesisMissingEvaluateAtError,
  type KnowledgeStorePort,
  KnowledgeWriteScopeRequiredError,
  type KnowledgeWriteSession,
  type NewDomain,
} from "../../port/knowledge-store.port.js";

// ---------------------------------------------------------------------------
// Confidence formula (mirrors DoltgresEdoResolverAdapter)
// ---------------------------------------------------------------------------

const WALK_CHAIN_DEFAULT_DEPTH = 5;
const WALK_CHAIN_MAX_DEPTH = 10;

function expectedEntryTypeForEdge(t: CitationType): readonly string[] | null {
  return HYPOTHESIS_TARGETED_EDGES.includes(t) ? citedEntryTypesFor(t) : null;
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
  private scopeOpen = false;
  private tail: Promise<void> = Promise.resolve();

  private assertWriteScope(): void {
    if (!this.scopeOpen) throw new KnowledgeWriteScopeRequiredError();
  }

  async withWrite<T>(
    input: { operationId: string; message: string },
    run: (write: KnowledgeWriteSession) => Promise<T>
  ): Promise<T> {
    if (this.scopeOpen) throw new KnowledgeWriteScopeRequiredError();
    const before = this.tail;
    let leave!: () => void;
    this.tail = new Promise<void>((resolve) => {
      leave = resolve;
    });
    await before;
    const scoped = new FakeKnowledgeStoreAdapter();
    for (const [id, row] of this.rows) scoped.rows.set(id, row);
    for (const [id, row] of this.edges) scoped.edges.set(id, row);
    for (const [id, row] of this.domainsMap) scoped.domainsMap.set(id, row);
    scoped.scopeOpen = true;
    try {
      const handle = new Proxy(scoped, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (!target.scopeOpen)
              return Promise.reject(new KnowledgeWriteScopeRequiredError());
            return Reflect.apply(value, target, args);
          };
        },
      });
      const value = await run(handle);
      const changed =
        JSON.stringify([...this.rows, ...this.edges, ...this.domainsMap]) !==
        JSON.stringify([...scoped.rows, ...scoped.edges, ...scoped.domainsMap]);
      this.rows.clear();
      for (const [id, row] of scoped.rows) this.rows.set(id, row);
      this.edges.clear();
      for (const [id, row] of scoped.edges) this.edges.set(id, row);
      this.domainsMap.clear();
      for (const [id, row] of scoped.domainsMap) this.domainsMap.set(id, row);
      if (changed)
        this.commitLog.push({
          hash: this.nextHash(),
          message: input.message,
          at: new Date(),
        });
      return value;
    } finally {
      scoped.scopeOpen = false;
      leave();
    }
  }

  // --- Read ---

  async getKnowledge(id: string): Promise<Knowledge | null> {
    return this.rows.get(id) ?? null;
  }

  async listKnowledge(
    domain: string,
    opts?: {
      tags?: string[];
      limit?: number;
      q?: string;
      includeEdo?: boolean;
    }
  ): Promise<Knowledge[]> {
    // Mirrors the Doltgres adapter's default EDO exclusion
    // (SCHEMA_REFINED_BY_READ_FILTER).
    let out = Array.from(this.rows.values()).filter(
      (r) =>
        r.domain === domain &&
        (opts?.includeEdo || !isEdoEntryType(r.entryType))
    );
    if (opts?.tags?.length) {
      const wanted = new Set(opts.tags);
      out = out.filter((r) => (r.tags ?? []).some((t) => wanted.has(t)));
    }
    const needle = opts?.q?.trim().toLowerCase();
    if (needle) {
      // Mirrors the Doltgres adapter: case-insensitive substring on `useWhen`
      // only; a null trigger never matches.
      out = out.filter((r) => r.useWhen?.toLowerCase().includes(needle));
    }
    out.sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }

  async listActiveGoals(): Promise<ActiveGoal[]> {
    // The fake holds only main-plane rows and has no status column, so every
    // row is a non-deprecated candidate; the cap matches the Doltgres adapter.
    return selectActiveGoals(
      Array.from(this.rows.values()).map((r) => ({
        id: r.id,
        entryType: r.entryType,
        title: r.title,
        content: r.content,
        evaluateAt: r.evaluateAt ?? null,
      }))
    );
  }

  async searchKnowledge(
    domain: string,
    query: string,
    opts?: { limit?: number; includeEdo?: boolean }
  ): Promise<Knowledge[]> {
    const q = query.toLowerCase();
    const out = Array.from(this.rows.values()).filter(
      (r) =>
        r.domain === domain &&
        (opts?.includeEdo || !isEdoEntryType(r.entryType)) &&
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
    return this.withWrite(
      {
        operationId: `domain.register:${input.id}`,
        message: `register domain ${input.id}`,
      },
      async (write) => {
        const scoped = write as FakeKnowledgeStoreAdapter;
        if (scoped.domainsMap.has(input.id)) {
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
        scoped.domainsMap.set(input.id, row);
        return row;
      }
    );
  }

  // --- Write — rows ---

  async upsertKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    this.assertWriteScope();
    if (!this.domainsMap.has(entry.domain)) {
      throw new DomainNotRegisteredError(entry.domain);
    }
    if (requiresEvaluateAt(entry.entryType) && !entry.evaluateAt) {
      throw new HypothesisMissingEvaluateAtError(entry.id, entry.entryType);
    }
    const existing = this.rows.get(entry.id);
    if (existing) {
      assertKnowledgeReplay(existing, entry);
      return existing;
    }
    const row: Knowledge = {
      id: entry.id,
      domain: entry.domain,
      entityId: entry.entityId ?? null,
      title: stripDangerousControlChars(entry.title),
      content: stripDangerousControlChars(entry.content),
      useWhen: entry.useWhen ? stripDangerousControlChars(entry.useWhen) : null,
      entryType: entry.entryType ?? "finding",
      confidencePct: initializeConfidence(entry).confidencePct,
      sourceType: entry.sourceType,
      sourceRef: entry.sourceRef ?? null,
      tags: entry.tags ?? null,
      evaluateAt: entry.evaluateAt ?? null,
      resolutionStrategy: entry.resolutionStrategy ?? null,
      createdAt: new Date(),
    };
    this.rows.set(entry.id, row);
    return row;
  }

  async addKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    this.assertWriteScope();
    if (!this.domainsMap.has(entry.domain)) {
      throw new DomainNotRegisteredError(entry.domain);
    }
    if (requiresEvaluateAt(entry.entryType) && !entry.evaluateAt) {
      throw new HypothesisMissingEvaluateAtError(entry.id, entry.entryType);
    }
    return this.upsertKnowledge(entry);
  }

  async updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge> {
    this.assertWriteScope();
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`Knowledge ${id} not found`);
    if (update.domain && !this.domainsMap.has(update.domain)) {
      throw new DomainNotRegisteredError(update.domain);
    }
    const merged: Knowledge = {
      ...existing,
      ...(update.domain !== undefined && { domain: update.domain }),
      ...(update.entityId !== undefined && { entityId: update.entityId }),
      ...(update.title !== undefined && {
        title: stripDangerousControlChars(update.title),
      }),
      ...(update.content !== undefined && {
        content: stripDangerousControlChars(update.content),
      }),
      ...(update.useWhen !== undefined && {
        useWhen:
          typeof update.useWhen === "string"
            ? stripDangerousControlChars(update.useWhen)
            : update.useWhen,
      }),
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
    this.assertWriteScope();
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
    this.assertWriteScope();
    const citingIsWork = isWorkItemEndpointId(edge.citingId);
    const citedIsWork = isWorkItemEndpointId(edge.citedId);
    const workEndpointCount = (citingIsWork ? 1 : 0) + (citedIsWork ? 1 : 0);
    if (workEndpointCount > 0 && workEndpointCount !== 1) {
      throw new Error(
        `citation edge must connect exactly one work item and one knowledge entry: ${edge.citingId} -> ${edge.citedId}`
      );
    }
    if (workEndpointCount > 0 && edge.citationType !== "tracks") {
      throw new Error(
        `work-item citation edge must use citation_type='tracks', got '${edge.citationType}'`
      );
    }
    if (workEndpointCount === 0 && edge.citationType === "tracks") {
      throw new Error(
        "citation_type='tracks' requires exactly one work-item endpoint"
      );
    }

    const citedRow = this.rows.get(edge.citedId);
    if (!citedRow && !citedIsWork) {
      throw new CitationTargetNotFoundError(edge.citedId);
    }
    if (citedIsWork && !citingIsWork && !this.rows.has(edge.citingId)) {
      throw new CitationTargetNotFoundError(edge.citingId);
    }
    const expected = expectedEntryTypeForEdge(edge.citationType);
    if (expected !== null && !expected.includes(citedRow?.entryType ?? "")) {
      throw new CitationTypeMismatchError(
        edge.citationType,
        edge.citedId,
        citedRow?.entryType ?? "(none)",
        expected.join("|")
      );
    }
    const id =
      edge.id ?? citationId(edge.citingId, edge.citedId, edge.citationType);
    // Idempotent on the unique tuple.
    const existing = [...this.edges.values()].find(
      (candidate) =>
        candidate.citingId === edge.citingId &&
        candidate.citedId === edge.citedId &&
        candidate.citationType === edge.citationType
    );
    if (existing) {
      if (existing.context !== (edge.context ?? null))
        throw new KnowledgeWriteConflictError(edge.citingId);
      return existing;
    }
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

  async listAllCitations(): Promise<Citation[]> {
    return Array.from(this.edges.values());
  }

  async listCitationLinks(
    endpointId: string,
    after?: string
  ): Promise<CitationLinkPage> {
    const candidates = Array.from(this.edges.values())
      .filter(
        (c) =>
          (c.citingId === endpointId || c.citedId === endpointId) &&
          (!after || c.id > after)
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const links = candidates.slice(0, 5).map((c) => ({
      id: c.id,
      citingId: c.citingId,
      citedId: c.citedId,
      citationType: c.citationType,
      context: c.context ?? null,
      sourceTitle: this.rows.get(c.citingId)?.title ?? null,
      targetTitle: this.rows.get(c.citedId)?.title ?? null,
    }));
    return {
      links,
      nextCursor: candidates.length > 5 ? (links.at(-1)?.id ?? null) : null,
    };
  }

  // --- Doltgres versioning (stubbed) ---

  async commit(_message: string): Promise<string> {
    throw new KnowledgeWriteScopeRequiredError();
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
      const rows = await this.store.listKnowledge(d, {
        limit: 10_000,
        includeEdo: true,
      });
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
    return this.store.withWrite(
      {
        operationId: `edo.resolve:${input.hypothesisId}`,
        message: `edo: resolve hypothesis ${input.hypothesisId}`,
      },
      async (write) => {
        const existing = (
          await write.listCitationsByCitedId(input.hypothesisId)
        ).find(
          (edge) =>
            edge.citationType === "validates" ||
            edge.citationType === "invalidates"
        );
        if (existing) {
          const canonical = await write.getKnowledge(existing.citingId);
          if (!canonical || existing.citationType !== input.edge)
            throw new KnowledgeWriteConflictError(input.outcomeId);
          assertKnowledgeReplay(canonical, {
            id: input.outcomeId,
            domain: input.domain,
            title: input.outcomeTitle,
            content: input.outcomeContent,
            entryType: "outcome",
            sourceType: input.sourceType,
            sourceRef: input.sourceRef ?? null,
          });
          return {
            outcomeId: existing.citingId,
            citationId: existing.id,
            resolvedConfidence:
              (await write.getKnowledge(input.hypothesisId))?.confidencePct ??
              0,
            alreadyResolved: true,
          };
        }

        // 1. Write the outcome row.
        // `confidencePct` is REQUIRED by the Doltgres schema (NOT NULL). Mirror
        // hypothesize/decide which seed initial confidence by source. Without
        // this, recordOutcome 500s on candidate-a (PR #1327 validation, 2026-05-28).
        const outcome = await write.addKnowledge({
          id: input.outcomeId,
          domain: input.domain,
          title: input.outcomeTitle,
          content: input.outcomeContent,
          entryType: "outcome",
          sourceType: input.sourceType,
          sourceRef: input.sourceRef ?? null,
          confidencePct: initializeConfidence({
            sourceType: input.sourceType,
          }).confidencePct,
        });

        // 2. Write the validates/invalidates citation.
        //    Adapter enforces CITATION_TARGET_EXISTS_AT_WRITE +
        //    EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE.
        const citation = await write.addCitation({
          citingId: outcome.id,
          citedId: input.hypothesisId,
          citationType: input.edge,
          context: `resolved by ${input.sourceType}`,
        });

        // 3. Recompute confidence on the hypothesis (1-hop, pure).
        const resolvedConfidence = await this.recomputeWithin(
          write,
          input.hypothesisId
        );

        return {
          outcomeId: outcome.id,
          citationId: citation.id,
          resolvedConfidence,
          alreadyResolved: false,
        };
      }
    );
  }

  async recomputeConfidence(entryId: string): Promise<number> {
    return this.store.withWrite(
      {
        operationId: `knowledge.confidence:${entryId}`,
        message: `recompute confidence ${entryId}`,
      },
      (write) => this.recomputeWithin(write, entryId)
    );
  }

  private async recomputeWithin(
    write: KnowledgeWriteSession,
    entryId: string
  ): Promise<number> {
    // RECOMPUTE_IS_PURE_FROM_CITATIONS — read all incoming edges + the row,
    // compute from scratch, write. Order-independent under concurrency.
    const entry = await write.getKnowledge(entryId);
    if (!entry) {
      throw new Error(`recomputeConfidence: entry '${entryId}' not found`);
    }
    if (isConfidenceExempt(entry.entryType)) return entry.confidencePct ?? 0;

    const incoming: Citation[] = await write.listCitationsByCitedId(entryId);
    const confidenceEdges = incoming.filter((c) => c.citationType !== "tracks");

    const next = recomputeConfidenceByPolicy(
      entry,
      confidenceEdges
    ).confidencePct;

    // Persist (idempotent — writing the same value is a no-op semantically).
    await write.updateKnowledge(entryId, { confidencePct: next });

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
