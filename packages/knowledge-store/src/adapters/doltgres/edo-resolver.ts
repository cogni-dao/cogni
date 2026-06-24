// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/edo-resolver`
 * Purpose: DoltgresEdoResolverAdapter — Doltgres-backed implementation of EdoResolverPort with pure-from-citations 1-hop confidence walks.
 * Scope: Adapter only. Does not contain port interfaces, env loading, or runtime lifecycle. SQL via sql.unsafe() + escapeValue() (Doltgres has no extended query protocol).
 * Invariants:
 *   - RECOMPUTE_IS_PURE_FROM_CITATIONS: recompute reads citations and computes from scratch.
 *   - RESOLVER_IDEMPOTENT: re-resolving an already-resolved hypothesis is a no-op.
 *   - All SQL via sql.unsafe() + escapeValue() for injection safety.
 * Side-effects: IO (database reads + writes + dolt_commit)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type { Sql } from "postgres";
import {
  initializeConfidence,
  recomputeConfidence as recomputeConfidenceByPolicy,
} from "../../domain/confidence-policy.js";
import type {
  Citation,
  CitationType,
  Knowledge,
} from "../../domain/schemas.js";
import type {
  ChainNode,
  EdoResolverPort,
  PendingResolutionsOptions,
  ResolutionInput,
  ResolutionResult,
  WalkChainOptions,
} from "../../port/edo-resolver.port.js";
import type { KnowledgeStorePort } from "../../port/knowledge-store.port.js";
import { escapeValue } from "./util.js";

// ---------------------------------------------------------------------------
// Chain-walk constants
// ---------------------------------------------------------------------------

const WALK_CHAIN_DEFAULT_DEPTH = 5;
const WALK_CHAIN_MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface DoltgresEdoResolverConfig {
  sql: Sql;
  /**
   * The KnowledgeStorePort used to mutate rows/edges + commit. Sharing the
   * same port ensures every resolver write goes through adapter invariants
   * (CITATION_TARGET_EXISTS_AT_WRITE, EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).
   */
  store: KnowledgeStorePort;
}

export class DoltgresEdoResolverAdapter implements EdoResolverPort {
  private readonly sql: Sql;
  private readonly store: KnowledgeStorePort;

  constructor(config: DoltgresEdoResolverConfig) {
    this.sql = config.sql;
    this.store = config.store;
  }

  async pendingResolutions(
    now: Date,
    opts?: PendingResolutionsOptions
  ): Promise<Knowledge[]> {
    const limit = opts?.limit ?? 100;
    const strategyFilter =
      opts?.strategy !== undefined
        ? opts.strategy.endsWith(":")
          ? `AND k.resolution_strategy LIKE ${escapeValue(`${opts.strategy}%`)}`
          : `AND k.resolution_strategy = ${escapeValue(opts.strategy)}`
        : "";
    // Exclude hypotheses that already have a validates/invalidates citation.
    const rows = await this.sql.unsafe(
      `SELECT k.* FROM knowledge k
       WHERE k.entry_type = 'hypothesis'
         AND k.resolution_strategy IS NOT NULL
         AND k.evaluate_at IS NOT NULL
         AND k.evaluate_at <= ${escapeValue(now)}
         ${strategyFilter}
         AND NOT EXISTS (
           SELECT 1 FROM citations c
           WHERE c.cited_id = k.id
             AND c.citation_type IN ('validates', 'invalidates')
         )
       ORDER BY k.evaluate_at
       LIMIT ${limit}`
    );
    return rows.map((r) =>
      rowToKnowledgeForResolver(r as Record<string, unknown>)
    );
  }

  async resolveHypothesis(input: ResolutionInput): Promise<ResolutionResult> {
    // RESOLVER_IDEMPOTENT: if a validates/invalidates already exists, no-op.
    const existing = await this.sql.unsafe(
      `SELECT id, citing_id, citation_type FROM citations
       WHERE cited_id = ${escapeValue(input.hypothesisId)}
         AND citation_type IN ('validates', 'invalidates')
       LIMIT 1`
    );
    if (existing.length > 0) {
      const row = existing[0] as Record<string, unknown>;
      const confidence = await this.recomputeConfidence(input.hypothesisId);
      return {
        // Return the EXISTING outcome row's id (the citing_id of the
        // resolving citation). Idempotency is keyed on the hypothesis.
        outcomeId: row.citing_id as string,
        citationId: row.id as string,
        resolvedConfidence: confidence,
        alreadyResolved: true,
      };
    }

    // 1. Write the outcome row.
    // `confidencePct` is REQUIRED by the Doltgres schema (NOT NULL). Mirror
    // hypothesize/decide which seed initial confidence by source. Without
    // this, recordOutcome 500s on candidate-a (PR #1327 validation, 2026-05-28).
    const outcome = await this.store.addKnowledge({
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
    const citation = await this.store.addCitation({
      citingId: outcome.id,
      citedId: input.hypothesisId,
      citationType: input.edge,
      context: `resolved by ${input.sourceType}`,
    });

    // 3. Recompute confidence on the hypothesis (1-hop, pure).
    const resolvedConfidence = await this.recomputeConfidence(
      input.hypothesisId
    );

    // 4. One Dolt commit per resolution.
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
    // RECOMPUTE_IS_PURE_FROM_CITATIONS — read all incoming edges + the row,
    // compute from scratch, write. Order-independent under concurrency.
    const entry = await this.store.getKnowledge(entryId);
    if (!entry) {
      throw new Error(`recomputeConfidence: entry '${entryId}' not found`);
    }

    const incoming: Citation[] =
      await this.store.listCitationsByCitedId(entryId);
    const confidenceEdges = incoming.filter((c) => c.citationType !== "tracks");

    const next = recomputeConfidenceByPolicy(
      entry,
      confidenceEdges
    ).confidencePct;

    // Persist (idempotent — writing the same value is a no-op semantically).
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

    // Bail fast if the root doesn't exist — keeps semantics with the fake.
    const rootRow = await this.store.getKnowledge(rootId);
    if (!rootRow) return [];

    // One recursive CTE walks both directions; the seed at depth 0 carries
    // NULL edge metadata. The recursive step joins through `citations` in
    // either direction and accumulates a visited-id set so cycles terminate
    // even if the BFS frontier would revisit. Each child row carries the
    // edge that brought it in (citation_type + direction).
    //
    // Doltgres 0.56 supports WITH RECURSIVE; postgres.js cannot send this
    // as a prepared statement (Doltgres extended-protocol limitation), so
    // build the whole text via sql.unsafe() + escapeValue() per the existing
    // resolver patterns.
    const rootIdSql = escapeValue(rootId);
    const includeOut = direction === "out" || direction === "both";
    const includeIn = direction === "in" || direction === "both";

    const recursiveStepBranches: string[] = [];
    if (includeOut) {
      // step out: walk[citing=parent] → cited
      recursiveStepBranches.push(
        `SELECT
           c.cited_id AS id,
           w.depth + 1 AS depth,
           c.citation_type AS edge_type,
           'out'::text AS edge_direction,
           w.path || c.cited_id AS path
         FROM citations c
         JOIN walk w ON w.id = c.citing_id
         WHERE w.depth + 1 <= ${maxDepth}
           AND NOT (c.cited_id = ANY(w.path))
           AND EXISTS (
             SELECT 1 FROM knowledge child WHERE child.id = c.cited_id
           )`
      );
    }
    if (includeIn) {
      // step in: walk[cited=parent] → citing
      recursiveStepBranches.push(
        `SELECT
           c.citing_id AS id,
           w.depth + 1 AS depth,
           c.citation_type AS edge_type,
           'in'::text AS edge_direction,
           w.path || c.citing_id AS path
         FROM citations c
         JOIN walk w ON w.id = c.cited_id
         WHERE w.depth + 1 <= ${maxDepth}
           AND NOT (c.citing_id = ANY(w.path))
           AND EXISTS (
             SELECT 1 FROM knowledge child WHERE child.id = c.citing_id
           )`
      );
    }

    // If both directions disabled (shouldn't happen — ChainDirection enum
    // covers only out/in/both), only the seed row is returned.
    const recursiveStep =
      recursiveStepBranches.length > 0
        ? recursiveStepBranches.join("\n         UNION ALL\n         ")
        : "SELECT id, depth, edge_type, edge_direction, path FROM walk WHERE FALSE";

    const sqlText = `WITH RECURSIVE walk(id, depth, edge_type, edge_direction, path) AS (
        SELECT
          ${rootIdSql}::text AS id,
          0 AS depth,
          NULL::text AS edge_type,
          NULL::text AS edge_direction,
          ARRAY[${rootIdSql}::text] AS path
        UNION ALL
        ${recursiveStep}
      ),
      -- Earliest visit per id (BFS-first / smallest depth wins). We dedupe
      -- at the post-CTE stage because the recursive UNION ALL keeps all
      -- discovery paths.
      first_visit AS (
        SELECT DISTINCT ON (id) id, depth, edge_type, edge_direction
        FROM walk
        ORDER BY id, depth
      )
      SELECT k.*, fv.depth, fv.edge_type, fv.edge_direction
      FROM first_visit fv
      JOIN knowledge k ON k.id = fv.id
      ORDER BY fv.depth, k.id`;

    const rows = await this.sql.unsafe(sqlText);
    return rows.map((r) => walkRowToChainNode(r as Record<string, unknown>));
  }
}

function walkRowToChainNode(row: Record<string, unknown>): ChainNode {
  const depth = Number(row.depth ?? 0);
  const edgeType = row.edge_type as CitationType | null;
  const edgeDirection = row.edge_direction as "out" | "in" | null;
  return {
    entry: rowToKnowledgeForResolver(row),
    depth,
    edgeFromParent:
      edgeType && edgeDirection
        ? { citationType: edgeType, direction: edgeDirection }
        : null,
  };
}

function rowToKnowledgeForResolver(row: Record<string, unknown>): Knowledge {
  return {
    id: row.id as string,
    domain: row.domain as string,
    entityId: (row.entity_id as string) ?? null,
    title: row.title as string,
    content: row.content as string,
    entryType: row.entry_type as string,
    confidencePct:
      row.confidence_pct != null ? Number(row.confidence_pct) : null,
    sourceType: row.source_type as Knowledge["sourceType"],
    sourceRef: (row.source_ref as string) ?? null,
    tags: row.tags as string[] | null,
    evaluateAt: row.evaluate_at ? new Date(row.evaluate_at as string) : null,
    resolutionStrategy: (row.resolution_strategy as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
  };
}
