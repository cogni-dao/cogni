// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres`
 * Purpose: DoltgresKnowledgeStoreAdapter — Doltgres-backed implementation of KnowledgeStorePort.
 * Scope: Adapter only. Uses postgres.js sql.unsafe() for all queries (Doltgres doesn't support
 *   the extended query protocol that postgres.js uses for parameterized queries).
 * Invariants:
 *   - All CRUD via sql.unsafe() with escapeValue() for injection safety.
 *   - Dolt versioning functions (dolt_commit, dolt_log, dolt_diff, dolt_hashof) via sql.unsafe().
 *   - No Drizzle query builder for writes (parameterized queries fail on Doltgres).
 *   - Connection string injected, never from process.env (PACKAGES_NO_ENV).
 * Side-effects: IO (database reads/writes)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import {
  DoltBranchMutationUncertainError,
  runDoltBranchMutation,
} from "@cogni-dao/doltgres-admission";
import type { Sql } from "postgres";
import { initializeConfidence } from "../../domain/confidence-policy.js";
import {
  type ActiveGoal,
  GOAL_ENTRY_TYPE,
  GoalRequiresContributionError,
  selectActiveGoals,
} from "../../domain/dao-goals.js";
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
  isWorkItemEndpointId,
  requiresEvaluateAt,
} from "../../domain/schemas.js";
import {
  assertExistingRowReplay,
  KnowledgeWriteConflictError,
} from "../../domain/write-replay.js";
import {
  type CitationLinkPage,
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  type Domain,
  DomainAlreadyRegisteredError,
  HypothesisMissingEvaluateAtError,
  type KnowledgeStorePort,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
  type KnowledgeWriteSession,
  type NewDomain,
} from "../../port/knowledge-store.port.js";
import type {
  DoltBranchSessionRunner,
  DoltWriteConnection,
} from "./session-admission.js";
import {
  assertDomainRegistered,
  escapeRef,
  escapeValue,
  insertColumnsSql,
  type SqlColumnValue,
  updateSetSql,
} from "./util.js";

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToKnowledge(row: Record<string, unknown>): Knowledge {
  return {
    id: row.id as string,
    domain: row.domain as string,
    entityId: (row.entity_id as string) ?? null,
    title: row.title as string,
    content: row.content as string,
    useWhen: (row.use_when as string) ?? null,
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

function rowToCitation(row: Record<string, unknown>): Citation {
  return {
    id: row.id as string,
    citingId: row.citing_id as string,
    citedId: row.cited_id as string,
    citationType: row.citation_type as CitationType,
    context: (row.context as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
  };
}

function knowledgeInsertColumns(entry: NewKnowledge): SqlColumnValue[] {
  const confidence = initializeConfidence(entry).confidencePct;
  return [
    { column: "id", value: entry.id },
    { column: "domain", value: entry.domain },
    { column: "entity_id", value: entry.entityId ?? undefined },
    { column: "title", value: stripDangerousControlChars(entry.title) },
    { column: "content", value: stripDangerousControlChars(entry.content) },
    {
      column: "use_when",
      value: entry.useWhen
        ? stripDangerousControlChars(entry.useWhen)
        : undefined,
    },
    { column: "entry_type", value: entry.entryType ?? undefined },
    { column: "confidence_pct", value: confidence },
    { column: "source_type", value: entry.sourceType },
    { column: "source_ref", value: entry.sourceRef ?? undefined },
    { column: "tags", value: entry.tags ?? undefined },
    { column: "evaluate_at", value: entry.evaluateAt ?? undefined },
    {
      column: "resolution_strategy",
      value: entry.resolutionStrategy ?? undefined,
    },
  ];
}

function knowledgeUpdateColumns(
  entry: Partial<NewKnowledge>
): SqlColumnValue[] {
  const columns: SqlColumnValue[] = [];
  const push = (column: string, key: keyof NewKnowledge): void => {
    if (!(key in entry)) return;
    // NO_NULL_CONFIDENCE_WRITES: never write confidence_pct = NULL. A nullish
    // value on update preserves the row's policy-managed confidence.
    if (key === "confidencePct" && entry[key] == null) return;
    const raw = entry[key];
    // PRESERVE_MARKDOWN_WHITESPACE: strip dangerous control chars from the
    // free-text fields on write (bug.5062), same as the insert path.
    const value =
      (key === "title" || key === "content" || key === "useWhen") &&
      typeof raw === "string"
        ? stripDangerousControlChars(raw)
        : raw;
    columns.push({ column, value });
  };

  push("domain", "domain");
  push("entity_id", "entityId");
  push("title", "title");
  push("content", "content");
  push("use_when", "useWhen");
  push("entry_type", "entryType");
  push("confidence_pct", "confidencePct");
  push("source_type", "sourceType");
  push("source_ref", "sourceRef");
  push("tags", "tags");
  push("evaluate_at", "evaluateAt");
  push("resolution_strategy", "resolutionStrategy");
  return columns;
}

/**
 * Derive a deterministic citation id from the unique edge tuple.
 * Keeps idempotency stable across retries and matches the unique index.
 */
function citationId(
  citingId: string,
  citedId: string,
  type: CitationType
): string {
  return `${citingId}->${citedId}:${type}`;
}

/**
 * EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE — strict edges that target hypotheses.
 * Mirrors HYPOTHESIS_TARGETED_EDGES from the domain layer.
 */
function expectedEntryTypeForEdge(
  type: CitationType
): readonly string[] | null {
  return HYPOTHESIS_TARGETED_EDGES.includes(type)
    ? citedEntryTypesFor(type)
    : null;
}

/**
 * HYPOTHESIS_HAS_EVALUATE_AT — adapter-level enforcement.
 * Rejects hypothesis rows that lack evaluate_at. Mirrors
 * DOMAIN_FK_ENFORCED_AT_WRITE pattern from task.5038.
 */
function assertHypothesisEvaluateAt(entry: NewKnowledge): void {
  if (requiresEvaluateAt(entry.entryType) && !entry.evaluateAt) {
    throw new HypothesisMissingEvaluateAtError(entry.id, entry.entryType);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DoltgresAdapterConfig {
  /**
   * A postgres.js Sql instance connected to the node's knowledge database.
   * Must be created with `fetch_types: false` for non-superuser roles.
   */
  sql: Sql;
  /** Existing shared branch admission; ordinary reads never use it. */
  writerSession?: DoltBranchSessionRunner;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DoltgresKnowledgeStoreAdapter implements KnowledgeStorePort {
  private sql: Sql | DoltWriteConnection;
  private readonly readSql: Sql;
  private readonly writerSession: DoltBranchSessionRunner | undefined;
  private scopeOpen = false;

  constructor(config: DoltgresAdapterConfig) {
    this.sql = config.sql;
    this.readSql = config.sql;
    this.writerSession = config.writerSession;
    this.writerSession?.assertIndependentReadClient(config.sql);
  }

  private assertWriteScope(): void {
    if (!this.scopeOpen) throw new KnowledgeWriteScopeRequiredError();
  }

  async withWrite<T>(
    input: { operationId: string; message: string },
    run: (write: KnowledgeWriteSession) => Promise<T>
  ): Promise<T> {
    if (this.scopeOpen || !this.writerSession)
      throw new KnowledgeWriteScopeRequiredError();
    const writer = this.writerSession;
    try {
      return await writer.run(
        "knowledge.logical_write",
        async (conn, guard, owner) => {
          const result = await runDoltBranchMutation(conn, {
            ...input,
            guard,
            onReconcile: owner.registerReconciliation,
            onCommitted: owner.committed,
            onSessionUncertain: (error) => writer.retire(conn, error),
            run: async (scopedConnection) => {
              const scoped = new DoltgresKnowledgeStoreAdapter({
                sql: this.readSql,
              });
              scoped.sql = {
                unsafe: async (query: string) =>
                  await scopedConnection.unsafe(query),
              };
              scoped.scopeOpen = true;
              try {
                return await run(scoped);
              } finally {
                scoped.scopeOpen = false;
              }
            },
          });
          return result.value;
        },
        input
      );
    } catch (error) {
      if (error instanceof DoltBranchMutationUncertainError)
        throw new KnowledgeWriteOutcomeUnknownError(
          error.operationId,
          error.branch,
          error.commitHash
        );
      throw error;
    }
  }

  // --- Read ---

  async getKnowledge(id: string): Promise<Knowledge | null> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge WHERE id = ${escapeValue(id)} LIMIT 1`
    );
    return rows.length > 0
      ? rowToKnowledge(rows[0] as Record<string, unknown>)
      : null;
  }

  async listKnowledge(
    domain: string,
    opts?: { tags?: string[]; limit?: number; q?: string }
  ): Promise<Knowledge[]> {
    const conditions = [`domain = ${escapeValue(domain)}`];

    if (opts?.tags && opts.tags.length > 0) {
      // Doltgres doesn't support JSONB @> operator yet.
      // Fallback: cast tags to text and use LIKE matching.
      const tagConditions = opts.tags.map(
        (tag) => `CAST(tags AS TEXT) LIKE ${escapeValue(`%"${tag}"%`)}`
      );
      conditions.push(`(${tagConditions.join(" OR ")})`);
    }

    const limit = opts?.limit ?? 100;
    const needle = opts?.q?.trim().toLowerCase();

    // `q` matches case-insensitively in the APP LAYER, not in Doltgres SQL —
    // the same idiom `searchKnowledge` already uses, and for the same reason:
    // Doltgres has no ILIKE, and LOWER() panics on out-of-line TEXT storage
    // (*val.TextStorage). `use_when` is a `text` column too, so it carries the
    // same hazard; there is no SQL case-folding idiom in this adapter that is
    // proven safe on `text`. The `q` path therefore fetches the shelf (domain
    // is indexed) WITHOUT the SQL LIMIT and truncates after filtering —
    // limiting first would silently drop matches outside the newest N. Both
    // collapse into the pgvector search index when it lands
    // (DOLT_IS_SOURCE_OF_TRUTH).
    if (needle) {
      const rows = await this.sql.unsafe(
        `SELECT * FROM knowledge WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`
      );
      const matched: Knowledge[] = [];
      for (const r of rows) {
        const entry = rowToKnowledge(r as Record<string, unknown>);
        // A null trigger never matches: an entry with no `useWhen` has not
        // stated a situation, so it cannot claim to fit the caller's.
        if (!entry.useWhen?.toLowerCase().includes(needle)) continue;
        matched.push(entry);
        if (matched.length >= limit) break;
      }
      return matched;
    }

    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`
    );
    return rows.map((r) => rowToKnowledge(r as Record<string, unknown>));
  }

  async searchKnowledge(
    domain: string,
    query: string,
    opts?: { limit?: number }
  ): Promise<Knowledge[]> {
    const limit = opts?.limit ?? 20;
    // Case-insensitive match runs in the app layer, NOT via Doltgres SQL:
    // Doltgres has no ILIKE, and LOWER() panics on out-of-line TEXT storage
    // (*val.TextStorage) — fatal on the large `content` column. Fetch the
    // domain's rows (domain is indexed) and filter here. Replaced by the
    // derived pgvector search index (DOLT_IS_SOURCE_OF_TRUTH) when it lands.
    const needle = query.toLowerCase();
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge WHERE domain = ${escapeValue(domain)} ORDER BY created_at DESC`
    );
    const matched: Knowledge[] = [];
    for (const r of rows) {
      const entry = rowToKnowledge(r as Record<string, unknown>);
      if (
        entry.title.toLowerCase().includes(needle) ||
        entry.content.toLowerCase().includes(needle)
      ) {
        matched.push(entry);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  async listActiveGoals(): Promise<ActiveGoal[]> {
    // Direct read of the main-plane `knowledge` table — contribution branches
    // are separate Dolt branches and never appear here. The id-prefix and
    // status checks run in `selectActiveGoals` (app layer) rather than SQL, the
    // same Doltgres-safe idiom as `searchKnowledge`; the shelf is tiny.
    const rows = await this.sql.unsafe(
      `SELECT id, entry_type, status, title, content, evaluate_at FROM knowledge WHERE entry_type = ${escapeValue(GOAL_ENTRY_TYPE)}`
    );
    return selectActiveGoals(
      rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as string,
          entryType: row.entry_type as string,
          status: (row.status as string | null) ?? null,
          title: row.title as string,
          content: row.content as string,
          evaluateAt: row.evaluate_at
            ? new Date(row.evaluate_at as string)
            : null,
        };
      })
    );
  }

  async listDomains(): Promise<string[]> {
    const rows = await this.sql.unsafe(
      "SELECT DISTINCT domain FROM knowledge ORDER BY domain"
    );
    return rows.map((r) => (r as Record<string, unknown>).domain as string);
  }

  // --- Domain registry (DOMAIN_FK_ENFORCED_AT_WRITE) ---

  async domainExists(id: string): Promise<boolean> {
    const rows = await this.sql.unsafe(
      `SELECT 1 FROM domains WHERE id = ${escapeValue(id)} LIMIT 1`
    );
    return rows.length > 0;
  }

  async listDomainsFull(): Promise<Domain[]> {
    const rows = await this.sql.unsafe(
      `SELECT d.id, d.name, d.description, d.confidence_pct, d.created_at, COUNT(k.id) AS entry_count FROM domains d LEFT JOIN knowledge k ON k.domain = d.id GROUP BY d.id, d.name, d.description, d.confidence_pct, d.created_at ORDER BY d.id`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const created = row.created_at;
      return {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string) ?? null,
        confidencePct: Number(row.confidence_pct ?? 40),
        entryCount: Number(row.entry_count ?? 0),
        createdAt:
          created instanceof Date
            ? created.toISOString()
            : String(created ?? ""),
      };
    });
  }

  async registerDomain(input: NewDomain): Promise<Domain> {
    return this.withWrite(
      {
        operationId: `domain.register:${input.id}`,
        message: `register domain ${input.id}`,
      },
      async (write) => {
        const scoped = write as DoltgresKnowledgeStoreAdapter;
        if (await write.domainExists(input.id))
          throw new DomainAlreadyRegisteredError(input.id);
        await scoped.sql.unsafe(
          `INSERT INTO domains (id, name, description) VALUES (${escapeValue(input.id)}, ${escapeValue(input.name)}, ${escapeValue(input.description ?? null)})`
        );
        const rows = await scoped.sql.unsafe(
          `SELECT d.id, d.name, d.description, d.confidence_pct, d.created_at, COUNT(k.id) AS entry_count FROM domains d LEFT JOIN knowledge k ON k.domain = d.id WHERE d.id = ${escapeValue(input.id)} GROUP BY d.id, d.name, d.description, d.confidence_pct, d.created_at LIMIT 1`
        );
        if (rows.length === 0) {
          throw new Error(`domain ${input.id} not found after register`);
        }
        const row = rows[0] as Record<string, unknown>;
        const created = row.created_at;
        return {
          id: row.id as string,
          name: row.name as string,
          description: (row.description as string) ?? null,
          confidencePct: Number(row.confidence_pct ?? 40),
          entryCount: Number(row.entry_count ?? 0),
          createdAt:
            created instanceof Date
              ? created.toISOString()
              : String(created ?? ""),
        };
      }
    );
  }

  // --- Write ---

  async upsertKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    this.assertWriteScope();
    await assertDomainRegistered(this.sql, entry.domain);
    assertHypothesisEvaluateAt(entry);
    const insert = insertColumnsSql(knowledgeInsertColumns(entry));

    const existing = await this.getKnowledge(entry.id);
    if (existing) {
      assertExistingRowReplay(existing, entry);
      return existing;
    }
    const rows = await this.sql.unsafe(
      `INSERT INTO knowledge (${insert.names}) VALUES (${insert.values}) RETURNING *`
    );
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async addKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    this.assertWriteScope();
    await assertDomainRegistered(this.sql, entry.domain);
    assertHypothesisEvaluateAt(entry);
    const existing = await this.getKnowledge(entry.id);
    if (existing) {
      assertExistingRowReplay(existing, entry);
      return existing;
    }
    const insert = insertColumnsSql(knowledgeInsertColumns(entry));

    const rows = await this.sql.unsafe(
      `INSERT INTO knowledge (${insert.names}) VALUES (${insert.values}) RETURNING *`
    );
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge> {
    this.assertWriteScope();
    // GOAL_WRITE_ONLY_VIA_CONTRIBUTION: no raw update touches a goal row.
    if ((await this.getKnowledgeEntryType(id)) === GOAL_ENTRY_TYPE)
      throw new GoalRequiresContributionError(id);
    if (update.domain !== undefined) {
      await assertDomainRegistered(this.sql, update.domain);
    }
    const setClauses = updateSetSql(knowledgeUpdateColumns(update));

    if (setClauses.length === 0) {
      const existing = await this.getKnowledge(id);
      if (!existing) throw new Error(`Knowledge ${id} not found`);
      return existing;
    }

    const rows = await this.sql.unsafe(
      `UPDATE knowledge SET ${setClauses} WHERE id = ${escapeValue(id)} RETURNING *`
    );
    if (rows.length === 0) throw new Error(`Knowledge ${id} not found`);
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async deleteKnowledge(id: string): Promise<void> {
    this.assertWriteScope();
    await this.sql.unsafe(
      `DELETE FROM knowledge WHERE id = ${escapeValue(id)}`
    );
  }

  // --- Knowledge identity (collapsed exists + entry_type for CITATION_TARGET_EXISTS_AT_WRITE + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE) ---

  async getKnowledgeEntryType(id: string): Promise<string | null> {
    const rows = await this.sql.unsafe(
      `SELECT entry_type FROM knowledge WHERE id = ${escapeValue(id)} LIMIT 1`
    );
    if (rows.length === 0) return null;
    return (rows[0] as Record<string, unknown>).entry_type as string;
  }

  async knowledgeExists(id: string): Promise<boolean> {
    return (await this.getKnowledgeEntryType(id)) !== null;
  }

  // --- Edges (knowledge-syntropy: hypothesis loop) ---

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
    if (citingIsWork) {
      const rows = await this.sql.unsafe(
        `SELECT 1 FROM work_items WHERE id = ${escapeValue(edge.citingId)} LIMIT 1`
      );
      if (rows.length === 0)
        throw new CitationTargetNotFoundError(edge.citingId);
    }
    if (citedIsWork) {
      const rows = await this.sql.unsafe(
        `SELECT 1 FROM work_items WHERE id = ${escapeValue(edge.citedId)} LIMIT 1`
      );
      if (rows.length === 0)
        throw new CitationTargetNotFoundError(edge.citedId);
    }

    const citedEntryType = !citedIsWork
      ? await this.getKnowledgeEntryType(edge.citedId)
      : null;
    if (!citedIsWork && citedEntryType === null) {
      throw new CitationTargetNotFoundError(edge.citedId);
    }
    if (citedIsWork && !citingIsWork) {
      const citingEntryType = await this.getKnowledgeEntryType(edge.citingId);
      if (citingEntryType === null) {
        throw new CitationTargetNotFoundError(edge.citingId);
      }
    }
    const expected = expectedEntryTypeForEdge(edge.citationType);
    if (expected !== null && !expected.includes(citedEntryType ?? "")) {
      throw new CitationTypeMismatchError(
        edge.citationType,
        edge.citedId,
        citedEntryType ?? "(none)",
        expected.join("|")
      );
    }

    const id =
      edge.id ?? citationId(edge.citingId, edge.citedId, edge.citationType);

    const existing = await this.sql.unsafe(
      `SELECT * FROM citations WHERE citing_id = ${escapeValue(edge.citingId)} AND cited_id = ${escapeValue(edge.citedId)} AND citation_type = ${escapeValue(edge.citationType)} LIMIT 1`
    );
    if (existing.length) {
      const canonical = rowToCitation(existing[0] as Record<string, unknown>);
      if (canonical.context !== (edge.context ?? null))
        throw new KnowledgeWriteConflictError(edge.citingId);
      return canonical;
    }
    const rows = await this.sql.unsafe(
      `INSERT INTO citations (id, citing_id, cited_id, citation_type, context) VALUES (${escapeValue(id)}, ${escapeValue(edge.citingId)}, ${escapeValue(edge.citedId)}, ${escapeValue(edge.citationType)}, ${escapeValue(edge.context ?? null)}) RETURNING *`
    );
    return rowToCitation(rows[0] as Record<string, unknown>);
  }

  async listCitationsByCitingId(citingId: string): Promise<Citation[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM citations WHERE citing_id = ${escapeValue(citingId)} ORDER BY created_at`
    );
    return rows.map((r) => rowToCitation(r as Record<string, unknown>));
  }

  async listCitationsByCitedId(citedId: string): Promise<Citation[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM citations WHERE cited_id = ${escapeValue(citedId)} ORDER BY created_at`
    );
    return rows.map((r) => rowToCitation(r as Record<string, unknown>));
  }

  async listCitationLinks(
    endpointId: string,
    after?: string
  ): Promise<CitationLinkPage> {
    const endpoint = escapeValue(endpointId);
    const cursor = after ? `AND id > ${escapeValue(after)}` : "";
    // Bound each indexed adjacency read before joining endpoint metadata.
    // One sentinel detects another page without counting the whole graph.
    const rows = await this.sql.unsafe(`
      WITH candidates AS (
        (SELECT id, citing_id, cited_id, citation_type, context
         FROM citations WHERE citing_id = ${endpoint} ${cursor}
         ORDER BY id LIMIT 6)
        UNION ALL
        (SELECT id, citing_id, cited_id, citation_type, context
         FROM citations WHERE cited_id = ${endpoint}
           AND citing_id <> ${endpoint} ${cursor}
         ORDER BY id LIMIT 6)
      ), page AS (
        SELECT id, citing_id, cited_id, citation_type, context
        FROM candidates ORDER BY id LIMIT 6
      )
      SELECT p.id, p.citing_id, p.cited_id, p.citation_type, p.context,
        COALESCE(sk.title, sw.title) AS source_title,
        COALESCE(tk.title, tw.title) AS target_title
      FROM page p
      LEFT JOIN knowledge sk ON sk.id = p.citing_id
      LEFT JOIN knowledge tk ON tk.id = p.cited_id
      LEFT JOIN work_items sw ON sw.id = p.citing_id
      LEFT JOIN work_items tw ON tw.id = p.cited_id
      ORDER BY p.id`);
    const links = rows.slice(0, 5).map((r) => ({
      id: r.id as string,
      citingId: r.citing_id as string,
      citedId: r.cited_id as string,
      citationType: r.citation_type as CitationType,
      context: (r.context as string | null) ?? null,
      sourceTitle: (r.source_title as string | null) ?? null,
      targetTitle: (r.target_title as string | null) ?? null,
    }));
    return {
      links,
      nextCursor: rows.length > 5 ? (links.at(-1)?.id ?? null) : null,
    };
  }

  async listAllCitations(): Promise<Citation[]> {
    const rows = await this.sql.unsafe(
      "SELECT * FROM citations ORDER BY created_at"
    );
    return rows.map((r) => rowToCitation(r as Record<string, unknown>));
  }

  // --- Doltgres versioning ---

  async commit(_message: string): Promise<string> {
    throw new KnowledgeWriteScopeRequiredError();
  }

  async log(limit?: number): Promise<DoltCommit[]> {
    const n = limit ?? 20;
    const rows = await this.sql.unsafe(
      `SELECT * FROM dolt_log ORDER BY date DESC LIMIT ${n}`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        commitHash: row.commit_hash as string,
        committer: row.committer as string,
        email: (row.email as string) ?? undefined,
        date: row.date as string,
        message: row.message as string,
      };
    });
  }

  async diff(fromRef: string, toRef: string): Promise<DoltDiffEntry[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM dolt_diff(${escapeRef(fromRef)}, ${escapeRef(toRef)}, 'knowledge')`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        diffType: row.diff_type as DoltDiffEntry["diffType"],
        fromId: (row.from_id as string) ?? null,
        toId: (row.to_id as string) ?? null,
        fromTitle: (row.from_title as string) ?? null,
        toTitle: (row.to_title as string) ?? null,
      };
    });
  }

  async currentCommit(): Promise<string> {
    const result = await this.sql.unsafe("SELECT dolt_hashof('HEAD') as hash");
    return (result[0] as Record<string, unknown>).hash as string;
  }
}

export type { DoltgresAdapterConfig as Config };
export {
  buildDoltgresClient,
  type DoltgresClientConfig,
} from "./build-client.js";
export {
  DoltgresKnowledgeContributionAdapter,
  type DoltgresKnowledgeContributionAdapterConfig,
} from "./contribution-adapter.js";
export {
  createDoltgresPusher,
  type DoltgresPushConfig,
  type DoltgresPusher,
  type PushOutcomeListener,
  wrapPushSafe,
} from "./dolt-remote.js";
export {
  DoltgresEdoResolverAdapter,
  type DoltgresEdoResolverConfig,
} from "./edo-resolver.js";
export {
  type BranchSessionLogger,
  type BranchSessionOptions,
  DoltBranchSessionRunner,
  KNOWLEDGE_BRANCH_LOCK_KEY,
} from "./session-admission.js";
