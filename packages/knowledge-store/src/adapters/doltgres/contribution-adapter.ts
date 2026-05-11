// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/contribution-adapter`
 * Purpose: Doltgres-backed implementation of KnowledgeContributionPort using Dolt branches.
 * Scope: Adapter only. Each contribution is one contrib/<agent>-<id> branch + one commit. Does not contain HTTP, validation, or business-logic policy.
 * Invariants:
 *   - All branch ops run inside sql.reserve() so dolt_checkout pins to one connection.
 *   - try/finally restores dolt_checkout('main') and releases the connection on error.
 *   - knowledge_contributions metadata table on main tracks state/principal/idempotency.
 *   - Reads from a branch use reserved-conn checkout (AS OF deferred to v1).
 * Side-effects: IO (database reads/writes, dolt branch ops)
 * Links: docs/design/knowledge-contribution-api.md, docs/spec/knowledge-data-plane.md
 * @public
 */

import { randomBytes } from "node:crypto";
import type { ReservedSql, Sql } from "postgres";
import type {
  ContributionDiffEntry,
  ContributionRecord,
  ContributionState,
  KnowledgeEntryInput,
  Principal,
} from "../../domain/contribution-schemas.js";
import {
  ContributionConflictError,
  ContributionNotFoundError,
  ContributionStateError,
  type KnowledgeContributionPort,
} from "../../port/contribution.port.js";
import { assertDomainRegistered, escapeRef, escapeValue } from "./util.js";

function principalSlug(p: Principal): string {
  return (p.name ?? p.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 32);
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function mapRecord(row: Record<string, unknown>): ContributionRecord {
  const created = row.created_at;
  const resolved = row.resolved_at;
  return {
    contributionId: String(row.id),
    branch: String(row.branch),
    commitHash: String(row.commit_hash),
    state: row.state as ContributionState,
    principalKind: row.principal_kind as "agent" | "user",
    principalId: String(row.principal_id),
    message: String(row.message),
    entryCount: Number(row.entry_count),
    mergedCommit: row.merged_commit ? String(row.merged_commit) : null,
    closedReason: row.closed_reason ? String(row.closed_reason) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    createdAt:
      created instanceof Date ? created.toISOString() : String(created ?? ""),
    resolvedAt:
      resolved instanceof Date
        ? resolved.toISOString()
        : resolved
          ? String(resolved)
          : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
  };
}

async function withReserved<T>(
  sql: Sql,
  fn: (conn: ReservedSql) => Promise<T>
): Promise<T> {
  const conn = await sql.reserve();
  try {
    return await fn(conn);
  } finally {
    try {
      await conn.unsafe(`SELECT dolt_checkout('main')`);
    } catch {
      /* swallow */
    }
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface DoltgresKnowledgeContributionAdapterConfig {
  sql: Sql;
}

export class DoltgresKnowledgeContributionAdapter
  implements KnowledgeContributionPort
{
  private readonly sql: Sql;

  constructor(config: DoltgresKnowledgeContributionAdapterConfig) {
    this.sql = config.sql;
  }

  async create(input: {
    principal: Principal;
    message: string;
    entries: KnowledgeEntryInput[];
    idempotencyKey?: string;
  }): Promise<ContributionRecord> {
    const slug = principalSlug(input.principal);
    const sid = shortId();
    const contributionId = `contrib-${slug}-${sid}`;
    const branch = `contrib/${slug}-${sid}`;
    const sourceRef = `agent:${input.principal.id}:${contributionId}`;

    // Pre-check FK on main (DOMAIN_FK_ENFORCED_AT_WRITE). A branch is always
    // created from main HEAD, so its `domains` table is identical at branch
    // time — checking before branch creation avoids leaking an empty branch
    // on rejection.
    for (const entry of input.entries) {
      await assertDomainRegistered(this.sql, entry.domain);
    }

    return await withReserved(this.sql, async (conn) => {
      // 1. Create branch from main HEAD
      await conn.unsafe(
        `SELECT dolt_checkout('-b', ${escapeRef(branch)}, 'main')`
      );

      // 2. Insert each entry on the feature branch
      for (const entry of input.entries) {
        const confidencePct =
          input.principal.kind === "agent" ? 30 : (entry.confidencePct ?? 30);
        const entryId = `${contributionId}:${randomBytes(3).toString("hex")}`;
        const entryType = entry.entryType ?? "finding";
        await conn.unsafe(
          `INSERT INTO knowledge (id, domain, entity_id, title, content, entry_type, confidence_pct, source_type, source_ref, tags) VALUES (${escapeValue(entryId)}, ${escapeValue(entry.domain)}, ${escapeValue(entry.entityId ?? null)}, ${escapeValue(entry.title)}, ${escapeValue(entry.content)}, ${escapeValue(entryType)}, ${escapeValue(confidencePct)}, ${escapeValue("external")}, ${escapeValue(sourceRef)}, ${entry.tags ? escapeValue(entry.tags) : "NULL"})`
        );
      }

      // 3. Commit on the branch
      const commitMsg = `contrib(${slug}): ${input.message}`;
      const commitResult = await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(commitMsg)})`
      );
      const commitField = (commitResult[0] as Record<string, unknown>)
        .dolt_commit;
      const commitHash = Array.isArray(commitField)
        ? String(commitField[0])
        : String(commitField);

      // 4. Back to main and write metadata row
      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(
        `INSERT INTO knowledge_contributions (id, branch, state, principal_id, principal_kind, message, entry_count, commit_hash, idempotency_key) VALUES (${escapeValue(contributionId)}, ${escapeValue(branch)}, 'open', ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(input.message)}, ${escapeValue(input.entries.length)}, ${escapeValue(commitHash)}, ${escapeValue(input.idempotencyKey ?? null)})`
      );
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(`contrib-meta: ${contributionId}`)})`
      );

      // 5. Read back the full record
      const rows = await conn.unsafe(
        `SELECT * FROM knowledge_contributions WHERE id = ${escapeValue(contributionId)} LIMIT 1`
      );
      return mapRecord(rows[0] as Record<string, unknown>);
    });
  }

  async list(query: {
    state: ContributionState | "all";
    principalId?: string;
    limit: number;
  }): Promise<ContributionRecord[]> {
    const conditions: string[] = [];
    if (query.state !== "all") {
      conditions.push(`state = ${escapeValue(query.state)}`);
    }
    if (query.principalId) {
      conditions.push(`principal_id = ${escapeValue(query.principalId)}`);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge_contributions ${where} ORDER BY created_at DESC LIMIT ${query.limit}`
    );
    return rows.map((r) => mapRecord(r as Record<string, unknown>));
  }

  async getById(contributionId: string): Promise<ContributionRecord | null> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge_contributions WHERE id = ${escapeValue(contributionId)} LIMIT 1`
    );
    return rows.length > 0
      ? mapRecord(rows[0] as Record<string, unknown>)
      : null;
  }

  async diff(contributionId: string): Promise<ContributionDiffEntry[]> {
    const rec = await this.getById(contributionId);
    if (!rec) throw new ContributionNotFoundError(contributionId);
    const rows = await this.sql.unsafe(
      `SELECT * FROM dolt_diff('main', ${escapeRef(rec.branch)}, 'knowledge')`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const diffType = String(row.diff_type ?? "modified");
      const before: Record<string, unknown> | null = row.from_id
        ? { id: row.from_id, title: row.from_title ?? null }
        : null;
      const after: Record<string, unknown> | null = row.to_id
        ? { id: row.to_id, title: row.to_title ?? null }
        : null;
      const rowId = String(row.to_id ?? row.from_id ?? "");
      return {
        changeType: diffType as ContributionDiffEntry["changeType"],
        rowId,
        before,
        after,
      };
    });
  }

  async merge(input: {
    contributionId: string;
    principal: Principal;
    confidencePct?: number;
  }): Promise<{ commitHash: string }> {
    const rec = await this.getById(input.contributionId);
    if (!rec) throw new ContributionNotFoundError(input.contributionId);
    if (rec.state !== "open") {
      throw new ContributionStateError(
        `contribution ${input.contributionId} is ${rec.state}`
      );
    }

    return await withReserved(this.sql, async (conn) => {
      await conn.unsafe(`SELECT dolt_checkout('main')`);

      let mergeCommit: string;
      try {
        const mergeRes = await conn.unsafe(
          `SELECT dolt_merge(${escapeRef(rec.branch)})`
        );
        const mergeField = (mergeRes[0] as Record<string, unknown>).dolt_merge;
        mergeCommit = Array.isArray(mergeField)
          ? String(mergeField[0])
          : String(mergeField);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ContributionConflictError(
          `dolt_merge failed for ${rec.branch}: ${msg}`
        );
      }

      if (input.confidencePct != null) {
        const sourceRef = `agent:${rec.principalId}:${rec.contributionId}`;
        await conn.unsafe(
          `UPDATE knowledge SET confidence_pct = ${escapeValue(input.confidencePct)} WHERE source_ref = ${escapeValue(sourceRef)}`
        );
      }

      await conn.unsafe(`SELECT dolt_branch('-D', ${escapeRef(rec.branch)})`);

      await conn.unsafe(
        `UPDATE knowledge_contributions SET state = 'merged', merged_commit = ${escapeValue(mergeCommit)}, resolved_at = now(), resolved_by = ${escapeValue(input.principal.id)} WHERE id = ${escapeValue(input.contributionId)}`
      );

      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(`contrib-merge: ${input.contributionId}`)})`
      );

      return { commitHash: mergeCommit };
    });
  }

  async close(input: {
    contributionId: string;
    principal: Principal;
    reason: string;
  }): Promise<void> {
    const rec = await this.getById(input.contributionId);
    if (!rec) throw new ContributionNotFoundError(input.contributionId);
    if (rec.state !== "open") {
      throw new ContributionStateError(
        `contribution ${input.contributionId} is ${rec.state}`
      );
    }

    await withReserved(this.sql, async (conn) => {
      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(`SELECT dolt_branch('-D', ${escapeRef(rec.branch)})`);
      await conn.unsafe(
        `UPDATE knowledge_contributions SET state = 'closed', closed_reason = ${escapeValue(input.reason)}, resolved_at = now(), resolved_by = ${escapeValue(input.principal.id)} WHERE id = ${escapeValue(input.contributionId)}`
      );
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(`contrib-close: ${input.contributionId}`)})`
      );
    });
  }
}
