// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/util`
 * Purpose: Shared SQL helpers for Doltgres adapters — escape utilities and the assertDomainRegistered FK-check used by both adapters.
 * Scope: Pure helpers + a single client-bound query. Does not own state, lifecycle, or env access.
 * Invariants:
 *   - escapeValue strips NUL bytes and escapes single quotes; standard_conforming_strings.
 *   - assertDomainRegistered MUST run on the same client/branch as the subsequent INSERT,
 *     so per-PR contribution branches check against the branch's own `domains` table.
 * Side-effects: IO (single SELECT inside assertDomainRegistered)
 * Links: docs/spec/knowledge-domain-registry.md
 * @internal
 */

import type { ReservedSql, Sql } from "postgres";
import { DomainNotRegisteredError } from "../../port/knowledge-store.port.js";

export interface SqlColumnValue {
  readonly column: string;
  readonly value: unknown;
}

export function escapeValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) throw new Error("Non-finite number");
    return String(val);
  }
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (Array.isArray(val) || typeof val === "object") {
    return `'${JSON.stringify(val).replace(/\0/g, "").replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(val).replace(/\0/g, "").replace(/'/g, "''")}'`;
}

export function escapeRef(ref: string): string {
  if (!/^[a-zA-Z0-9_./~^-]+$/.test(ref)) {
    throw new Error(`Invalid Dolt ref: ${ref}`);
  }
  return `'${ref}'`;
}

export function definedSqlColumns(
  columns: readonly SqlColumnValue[]
): SqlColumnValue[] {
  return columns.filter((c) => c.value !== undefined);
}

export function insertColumnsSql(columns: readonly SqlColumnValue[]): {
  readonly names: string;
  readonly values: string;
} {
  const defined = definedSqlColumns(columns);
  if (defined.length === 0) {
    throw new Error("insert requires at least one column");
  }
  return {
    names: defined.map((c) => c.column).join(", "),
    values: defined.map((c) => escapeValue(c.value)).join(", "),
  };
}

export function updateSetSql(columns: readonly SqlColumnValue[]): string {
  return definedSqlColumns(columns)
    .map((c) => `${c.column} = ${escapeValue(c.value)}`)
    .join(", ");
}

/**
 * FK gate for `knowledge.domain`. Throws `DomainNotRegisteredError` if the
 * domain is not present in the `domains` table on the caller's client.
 *
 * Both Doltgres adapters call this before INSERT INTO knowledge:
 *   - DoltgresKnowledgeStoreAdapter.{add,upsert}Knowledge (covers core__knowledge_write)
 *   - DoltgresKnowledgeContributionAdapter.create (covers HTTP contributions)
 *
 * Accepts either a top-level `Sql` or a `ReservedSql` (per-branch reserved
 * connection used by the contribution flow), so the check runs against the
 * same DB state the INSERT will hit.
 */
export async function assertDomainRegistered(
  client: Sql | ReservedSql,
  domain: string
): Promise<void> {
  const rows = await client.unsafe(
    `SELECT 1 FROM domains WHERE id = ${escapeValue(domain)} LIMIT 1`
  );
  if (rows.length === 0) {
    throw new DomainNotRegisteredError(domain);
  }
}
