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

import type { Sql } from "postgres";
import type {
  DoltCommit,
  DoltDiffEntry,
  Knowledge,
  NewKnowledge,
} from "../../domain/schemas.js";
import {
  type Domain,
  DomainAlreadyRegisteredError,
  type KnowledgeStorePort,
  type NewDomain,
} from "../../port/knowledge-store.port.js";
import { assertDomainRegistered, escapeRef, escapeValue } from "./util.js";

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
    entryType: row.entry_type as string,
    confidencePct:
      row.confidence_pct != null ? Number(row.confidence_pct) : null,
    sourceType: row.source_type as Knowledge["sourceType"],
    sourceRef: (row.source_ref as string) ?? null,
    tags: row.tags as string[] | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
  };
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
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DoltgresKnowledgeStoreAdapter implements KnowledgeStorePort {
  private readonly sql: Sql;

  constructor(config: DoltgresAdapterConfig) {
    this.sql = config.sql;
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
    opts?: { tags?: string[]; limit?: number }
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
    // Doltgres doesn't support ILIKE. Use LOWER() + LIKE as fallback.
    // Escape LIKE wildcards in user query to prevent unintended pattern matching.
    const escaped = query.toLowerCase().replace(/[%_\\]/g, "\\$&");
    const lowerQuery = escapeValue(`%${escaped}%`);
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge WHERE domain = ${escapeValue(domain)} AND (LOWER(title) LIKE ${lowerQuery} OR LOWER(content) LIKE ${lowerQuery}) ORDER BY created_at DESC LIMIT ${limit}`
    );
    return rows.map((r) => rowToKnowledge(r as Record<string, unknown>));
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
    try {
      await this.sql.unsafe(
        `INSERT INTO domains (id, name, description) VALUES (${escapeValue(input.id)}, ${escapeValue(input.name)}, ${escapeValue(input.description ?? null)})`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("duplicate")) {
        throw new DomainAlreadyRegisteredError(input.id);
      }
      throw e;
    }
    await this.sql.unsafe(
      `SELECT dolt_commit('-Am', ${escapeValue(`register domain ${input.id}`)})`
    );
    const rows = await this.sql.unsafe(
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
        created instanceof Date ? created.toISOString() : String(created ?? ""),
    };
  }

  // --- Write ---

  async upsertKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    await assertDomainRegistered(this.sql, entry.domain);
    const cols = [
      "id",
      "domain",
      "entity_id",
      "title",
      "content",
      "entry_type",
      "confidence_pct",
      "source_type",
      "source_ref",
      "tags",
    ];
    const vals = [
      escapeValue(entry.id),
      escapeValue(entry.domain),
      escapeValue(entry.entityId ?? null),
      escapeValue(entry.title),
      escapeValue(entry.content),
      escapeValue(entry.entryType ?? "finding"),
      escapeValue(entry.confidencePct ?? null),
      escapeValue(entry.sourceType),
      escapeValue(entry.sourceRef ?? null),
      entry.tags ? escapeValue(entry.tags) : "NULL",
    ];

    // Doltgres does not support EXCLUDED or ON CONFLICT DO UPDATE reliably.
    // Use insert-or-update: try INSERT, on duplicate key fall back to UPDATE.
    try {
      const rows = await this.sql.unsafe(
        `INSERT INTO knowledge (${cols.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`
      );
      return rowToKnowledge(rows[0] as Record<string, unknown>);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate") && !msg.includes("Duplicate")) throw e;
    }
    // Row exists — update it
    const updateCols = cols.slice(1); // skip id (PK)
    const updateVals = vals.slice(1);
    const setClauses = updateCols
      .map((col, i) => `${col} = ${updateVals[i]}`)
      .join(", ");
    const rows = await this.sql.unsafe(
      `UPDATE knowledge SET ${setClauses} WHERE id = ${escapeValue(entry.id)} RETURNING *`
    );
    if (rows.length === 0)
      throw new Error(`Knowledge ${entry.id} not found after upsert`);
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async addKnowledge(entry: NewKnowledge): Promise<Knowledge> {
    await assertDomainRegistered(this.sql, entry.domain);
    const cols = [
      "id",
      "domain",
      "entity_id",
      "title",
      "content",
      "entry_type",
      "confidence_pct",
      "source_type",
      "source_ref",
      "tags",
    ];
    const vals = [
      escapeValue(entry.id),
      escapeValue(entry.domain),
      escapeValue(entry.entityId ?? null),
      escapeValue(entry.title),
      escapeValue(entry.content),
      escapeValue(entry.entryType ?? "finding"),
      escapeValue(entry.confidencePct ?? null),
      escapeValue(entry.sourceType),
      escapeValue(entry.sourceRef ?? null),
      entry.tags ? escapeValue(entry.tags) : "NULL",
    ];

    const rows = await this.sql.unsafe(
      `INSERT INTO knowledge (${cols.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`
    );
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge> {
    if (update.domain !== undefined) {
      await assertDomainRegistered(this.sql, update.domain);
    }
    const setClauses: string[] = [];
    const fieldMap: Record<string, keyof NewKnowledge> = {
      domain: "domain",
      entity_id: "entityId",
      title: "title",
      content: "content",
      entry_type: "entryType",
      confidence_pct: "confidencePct",
      source_type: "sourceType",
      source_ref: "sourceRef",
      tags: "tags",
    };

    for (const [col, key] of Object.entries(fieldMap)) {
      if (key in update) {
        setClauses.push(`${col} = ${escapeValue(update[key])}`);
      }
    }

    if (setClauses.length === 0) {
      const existing = await this.getKnowledge(id);
      if (!existing) throw new Error(`Knowledge ${id} not found`);
      return existing;
    }

    const rows = await this.sql.unsafe(
      `UPDATE knowledge SET ${setClauses.join(", ")} WHERE id = ${escapeValue(id)} RETURNING *`
    );
    if (rows.length === 0) throw new Error(`Knowledge ${id} not found`);
    return rowToKnowledge(rows[0] as Record<string, unknown>);
  }

  async deleteKnowledge(id: string): Promise<void> {
    await this.sql.unsafe(
      `DELETE FROM knowledge WHERE id = ${escapeValue(id)}`
    );
  }

  // --- Doltgres versioning ---

  async commit(message: string): Promise<string> {
    const result = await this.sql.unsafe(
      `SELECT dolt_commit('-Am', ${escapeValue(message)})`
    );
    // dolt_commit returns { dolt_commit: ['<hash>'] }
    const raw = result[0] as Record<string, unknown>;
    const commitField = raw.dolt_commit;
    if (Array.isArray(commitField)) return commitField[0] as string;
    return String(commitField);
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
