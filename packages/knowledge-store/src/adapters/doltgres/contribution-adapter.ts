// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/contribution-adapter`
 * Purpose: Doltgres-backed implementation of KnowledgeContributionPort using Dolt branches.
 * Scope: Adapter only. Each contribution is one contrib/<agent>-<id> branch that can receive many logical commits. Does not contain HTTP or business-logic policy.
 * Invariants:
 *   - All branch ops run inside sql.reserve() so dolt_checkout pins to one connection.
 *   - Appends for the same contribution are serialized in-process and guarded
 *     against stale metadata before recording the next sequence number.
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
  ContributionCommitRecord,
  ContributionDiffEntry,
  ContributionRecord,
  ContributionState,
  KnowledgeContributionEdit,
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function sourceRef(contributionId: string, seq: number): string {
  return `${sourceRefPrefix(contributionId)}${seq}`;
}

function sourceRefPrefix(contributionId: string): string {
  return `contribution:${contributionId}:`;
}

function contributionMessage(slug: string, message: string): string {
  return `contrib(${slug}): ${message}`;
}

function metaMessage(contributionId: string, seq?: number): string {
  return seq
    ? `contrib-meta: ${contributionId}:${seq}`
    : `contrib-meta: ${contributionId}`;
}

const contributionAppendLocks = new Map<string, Promise<void>>();

async function withContributionAppendLock<T>(
  contributionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = contributionAppendLocks.get(contributionId);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => current);

  contributionAppendLocks.set(contributionId, queued);
  if (previous) {
    await previous.catch(() => undefined);
  }

  try {
    return await fn();
  } finally {
    release();
    if (contributionAppendLocks.get(contributionId) === queued) {
      contributionAppendLocks.delete(contributionId);
    }
  }
}

function mapRecord(row: Record<string, unknown>): ContributionRecord {
  return {
    contributionId: String(row.id),
    branch: String(row.branch),
    baseCommit: normalizeDoltCommitRef(String(row.base_commit)),
    headCommit: normalizeOptionalDoltCommitRef(row.head_commit),
    commitCount: Number(row.commit_count),
    state: row.state as ContributionState,
    principalKind: row.principal_kind as "agent" | "user",
    principalId: String(row.principal_id),
    message: String(row.message),
    mergedCommit: normalizeOptionalDoltCommitRef(row.merged_commit),
    closedReason: optionalString(row.closed_reason),
    idempotencyKey: optionalString(row.idempotency_key),
    createdAt: dateString(row.created_at),
    resolvedAt: row.resolved_at ? dateString(row.resolved_at) : null,
    resolvedBy: optionalString(row.resolved_by),
  };
}

function mapCommitRecord(
  row: Record<string, unknown>
): ContributionCommitRecord {
  return {
    contributionId: String(row.contribution_id),
    seq: Number(row.seq),
    commitHash: normalizeDoltCommitRef(String(row.commit_hash)),
    principalKind: row.principal_kind as "agent" | "user",
    principalId: String(row.principal_id),
    authSource: row.auth_source as "bearer" | "session",
    message: String(row.message),
    editCount: Number(row.edit_count),
    sourceRef: String(row.source_ref),
    createdAt: dateString(row.created_at),
  };
}

function parseDoltResult(
  row: Record<string, unknown>,
  field: "dolt_commit" | "dolt_merge" | "dolt_hashof"
): string {
  const value = row[field];
  return normalizeDoltCommitRef(
    Array.isArray(value) ? String(value[0]) : String(value)
  );
}

function normalizeDoltCommitRef(ref: string): string {
  return ref.startsWith("{") && ref.endsWith("}") ? ref.slice(1, -1) : ref;
}

function normalizeOptionalDoltCommitRef(value: unknown): string | null {
  const ref = optionalString(value);
  return ref ? normalizeDoltCommitRef(ref) : null;
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

async function currentHash(conn: ReservedSql, ref: string): Promise<string> {
  const rows = await conn.unsafe(
    `SELECT dolt_hashof(${escapeRef(ref)}) AS dolt_hashof`
  );
  return parseDoltResult(rows[0] as Record<string, unknown>, "dolt_hashof");
}

async function assertKnowledgeRowExists(
  conn: ReservedSql,
  targetRowId: string
): Promise<void> {
  const rows = await conn.unsafe(
    `SELECT 1 FROM knowledge WHERE id = ${escapeValue(targetRowId)} LIMIT 1`
  );
  if (rows.length === 0) {
    throw new ContributionNotFoundError(
      `knowledge row not found: ${targetRowId}`
    );
  }
}

async function applyEdit(input: {
  conn: ReservedSql;
  contributionId: string;
  principal: Principal;
  seq: number;
  edit: KnowledgeContributionEdit;
}): Promise<void> {
  const { conn, contributionId, principal, seq, edit } = input;
  const ref = sourceRef(contributionId, seq);
  const sourceNode = principal.id;
  if (edit.op === "deprecate") {
    await assertKnowledgeRowExists(conn, edit.targetRowId);
    await conn.unsafe(
      `UPDATE knowledge SET status = ${escapeValue("deprecated")}, source_type = ${escapeValue("external")}, source_ref = ${escapeValue(ref)}, source_node = ${escapeValue(sourceNode)}, updated_at = now() WHERE id = ${escapeValue(edit.targetRowId)}`
    );
    return;
  }

  await assertDomainRegistered(conn, edit.entry.domain);
  const confidencePct =
    principal.kind === "agent" ? 30 : (edit.entry.confidencePct ?? 30);
  if (edit.op === "update") {
    await assertKnowledgeRowExists(conn, edit.targetRowId);
    const entryType = edit.entry.entryType ?? "finding";
    const result = await conn.unsafe(
      `UPDATE knowledge SET domain = ${escapeValue(edit.entry.domain)}, entity_id = ${escapeValue(edit.entry.entityId ?? null)}, title = ${escapeValue(edit.entry.title)}, content = ${escapeValue(edit.entry.content)}, entry_type = ${escapeValue(entryType)}, confidence_pct = ${escapeValue(confidencePct)}, source_type = ${escapeValue("external")}, source_ref = ${escapeValue(ref)}, source_node = ${escapeValue(sourceNode)}, tags = ${edit.entry.tags ? escapeValue(edit.entry.tags) : "NULL"}, updated_at = now() WHERE id = ${escapeValue(edit.targetRowId)}`
    );
    if (result.count === 0) {
      throw new ContributionNotFoundError(
        `knowledge row not found: ${edit.targetRowId}`
      );
    }
    return;
  }

  // Server-stamped fallback id uses `-` not `:` so the result satisfies the
  // v0 shape gate (kebab only). The contribution prefix is still long; this
  // is a transitional concession — clients SHOULD supply `entry.id`
  // explicitly per the syntropy expert decision tree (write atomic with a
  // sharp slug). Auto-stamps will be removed once the UI form enforces
  // explicit ids (P0.6.v0b).
  const entryId =
    edit.entry.id ?? `${contributionId}-${randomBytes(3).toString("hex")}`;
  const entryType = edit.entry.entryType ?? "finding";
  await conn.unsafe(
    `INSERT INTO knowledge (id, domain, entity_id, title, content, entry_type, confidence_pct, source_type, source_ref, source_node, tags) VALUES (${escapeValue(entryId)}, ${escapeValue(edit.entry.domain)}, ${escapeValue(edit.entry.entityId ?? null)}, ${escapeValue(edit.entry.title)}, ${escapeValue(edit.entry.content)}, ${escapeValue(entryType)}, ${escapeValue(confidencePct)}, ${escapeValue("external")}, ${escapeValue(ref)}, ${escapeValue(sourceNode)}, ${edit.entry.tags ? escapeValue(edit.entry.tags) : "NULL"})`
  );
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
    edits?: KnowledgeContributionEdit[];
    idempotencyKey?: string;
  }): Promise<ContributionRecord> {
    const slug = principalSlug(input.principal);
    const sid = shortId();
    const contributionId = `contrib-${slug}-${sid}`;
    const branch = `contrib/${slug}-${sid}`;
    const edits = input.edits ?? [];

    return await withReserved(this.sql, async (conn) => {
      const baseCommit = await currentHash(conn, "main");
      await conn.unsafe(
        `SELECT dolt_checkout('-b', ${escapeRef(branch)}, 'main')`
      );

      let headCommit: string | null = null;
      if (edits.length > 0) {
        for (const edit of edits) {
          await applyEdit({
            conn,
            contributionId,
            principal: input.principal,
            seq: 1,
            edit,
          });
        }
        const commitMessage = contributionMessage(slug, input.message);
        const commitResult = await conn.unsafe(
          `SELECT dolt_commit('-Am', ${escapeValue(commitMessage)})`
        );
        headCommit = parseDoltResult(
          commitResult[0] as Record<string, unknown>,
          "dolt_commit"
        );
      }

      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(
        `INSERT INTO knowledge_contributions (id, branch, state, principal_id, principal_kind, message, base_commit, head_commit, commit_count, idempotency_key) VALUES (${escapeValue(contributionId)}, ${escapeValue(branch)}, 'open', ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(input.message)}, ${escapeValue(baseCommit)}, ${escapeValue(headCommit)}, ${edits.length > 0 ? 1 : 0}, ${escapeValue(input.idempotencyKey ?? null)})`
      );
      if (headCommit) {
        const ref = sourceRef(contributionId, 1);
        const authSource =
          input.principal.kind === "agent" ? "bearer" : "session";
        await conn.unsafe(
          `INSERT INTO knowledge_contribution_commits (contribution_id, seq, commit_hash, principal_id, principal_kind, auth_source, message, edit_count, source_ref) VALUES (${escapeValue(contributionId)}, 1, ${escapeValue(headCommit)}, ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(authSource)}, ${escapeValue(input.message)}, ${edits.length}, ${escapeValue(ref)})`
        );
      }
      const metadataMessage = metaMessage(contributionId);
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(metadataMessage)})`
      );

      const rows = await conn.unsafe(
        `SELECT * FROM knowledge_contributions WHERE id = ${escapeValue(contributionId)} LIMIT 1`
      );
      return mapRecord(rows[0] as Record<string, unknown>);
    });
  }

  async appendCommit(input: {
    contributionId: string;
    principal: Principal;
    message: string;
    edits: KnowledgeContributionEdit[];
  }): Promise<ContributionCommitRecord> {
    return await withContributionAppendLock(input.contributionId, async () => {
      const rec = await this.getById(input.contributionId);
      if (!rec) throw new ContributionNotFoundError(input.contributionId);
      if (rec.state !== "open") {
        throw new ContributionStateError(
          `contribution ${input.contributionId} is ${rec.state}`
        );
      }
      const seq = rec.commitCount + 1;
      const ref = sourceRef(input.contributionId, seq);
      const expectedHead = rec.headCommit ?? rec.baseCommit;
      const headPredicate = rec.headCommit
        ? `head_commit = ${escapeValue(rec.headCommit)}`
        : "head_commit IS NULL";

      return await withReserved(this.sql, async (conn) => {
        await conn.unsafe(`SELECT dolt_checkout(${escapeRef(rec.branch)})`);
        const actualHead = await currentHash(conn, rec.branch);
        if (
          normalizeDoltCommitRef(actualHead) !==
          normalizeDoltCommitRef(expectedHead)
        ) {
          throw new ContributionConflictError(
            `contribution ${input.contributionId} branch head changed while appending`
          );
        }

        for (const edit of input.edits) {
          await applyEdit({
            conn,
            contributionId: input.contributionId,
            principal: input.principal,
            seq,
            edit,
          });
        }
        const commitMessage = contributionMessage(
          principalSlug(input.principal),
          input.message
        );
        const commitResult = await conn.unsafe(
          `SELECT dolt_commit('-Am', ${escapeValue(commitMessage)})`
        );
        const commitHash = parseDoltResult(
          commitResult[0] as Record<string, unknown>,
          "dolt_commit"
        );

        await conn.unsafe(`SELECT dolt_checkout('main')`);
        const updateResult = await conn.unsafe(
          `UPDATE knowledge_contributions SET head_commit = ${escapeValue(commitHash)}, commit_count = ${seq} WHERE id = ${escapeValue(input.contributionId)} AND commit_count = ${rec.commitCount} AND ${headPredicate}`
        );
        if (updateResult.count === 0) {
          throw new ContributionConflictError(
            `contribution ${input.contributionId} changed while appending`
          );
        }
        const authSource =
          input.principal.kind === "agent" ? "bearer" : "session";
        await conn.unsafe(
          `INSERT INTO knowledge_contribution_commits (contribution_id, seq, commit_hash, principal_id, principal_kind, auth_source, message, edit_count, source_ref) VALUES (${escapeValue(input.contributionId)}, ${seq}, ${escapeValue(commitHash)}, ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(authSource)}, ${escapeValue(input.message)}, ${input.edits.length}, ${escapeValue(ref)})`
        );
        const metadataMessage = metaMessage(input.contributionId, seq);
        await conn.unsafe(
          `SELECT dolt_commit('-Am', ${escapeValue(metadataMessage)})`
        );

        const rows = await conn.unsafe(
          `SELECT * FROM knowledge_contribution_commits WHERE contribution_id = ${escapeValue(input.contributionId)} AND seq = ${seq} LIMIT 1`
        );
        return mapCommitRecord(rows[0] as Record<string, unknown>);
      });
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

  async listCommits(
    contributionId: string
  ): Promise<ContributionCommitRecord[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge_contribution_commits WHERE contribution_id = ${escapeValue(contributionId)} ORDER BY seq ASC`
    );
    return rows.map((r) => mapCommitRecord(r as Record<string, unknown>));
  }

  async diff(contributionId: string): Promise<ContributionDiffEntry[]> {
    const rec = await this.getById(contributionId);
    if (!rec) throw new ContributionNotFoundError(contributionId);
    // Legacy contributions migrated by 0002 collapsed base_commit/head_commit
    // to the same commit hash, so dolt_diff(base, head) is empty and the
    // review surface goes blank. For open legacy branches, fall back to the
    // pre-PR behavior of diffing main against the live branch ref.
    const legacyCollapsed =
      rec.headCommit !== null && rec.baseCommit === rec.headCommit;
    const fromRef =
      legacyCollapsed && rec.state === "open" ? "main" : rec.baseCommit;
    const toRef =
      legacyCollapsed && rec.state === "open"
        ? rec.branch
        : (rec.headCommit ?? rec.baseCommit);
    const rows = await this.sql.unsafe(
      `SELECT * FROM dolt_diff(${escapeRef(fromRef)}, ${escapeRef(toRef)}, 'knowledge')`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const diffType = String(row.diff_type ?? "modified");
      const before: Record<string, unknown> | null = row.from_id
        ? {
            id: row.from_id,
            title: row.from_title ?? null,
            content: row.from_content ?? null,
            entryType: row.from_entry_type ?? null,
            domain: row.from_domain ?? null,
          }
        : null;
      const after: Record<string, unknown> | null = row.to_id
        ? {
            id: row.to_id,
            title: row.to_title ?? null,
            content: row.to_content ?? null,
            entryType: row.to_entry_type ?? null,
            domain: row.to_domain ?? null,
          }
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
        const refPattern = `${sourceRefPrefix(rec.contributionId)}%`;
        await conn.unsafe(
          `UPDATE knowledge SET confidence_pct = ${escapeValue(input.confidencePct)} WHERE source_ref LIKE ${escapeValue(refPattern)}`
        );
      }

      await conn.unsafe(
        `UPDATE knowledge_contributions SET state = 'merged', merged_commit = ${escapeValue(mergeCommit)}, resolved_at = now(), resolved_by = ${escapeValue(input.principal.id)} WHERE id = ${escapeValue(input.contributionId)}`
      );

      const mergeMessage = `contrib-merge: ${input.contributionId}`;
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(mergeMessage)})`
      );
      await conn.unsafe(`SELECT dolt_branch('-D', ${escapeRef(rec.branch)})`);

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
      await conn.unsafe(
        `UPDATE knowledge_contributions SET state = 'closed', closed_reason = ${escapeValue(input.reason)}, resolved_at = now(), resolved_by = ${escapeValue(input.principal.id)} WHERE id = ${escapeValue(input.contributionId)}`
      );
      const closeMessage = `contrib-close: ${input.contributionId}`;
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(closeMessage)})`
      );
      await conn.unsafe(`SELECT dolt_branch('-D', ${escapeRef(rec.branch)})`);
    });
  }
}
