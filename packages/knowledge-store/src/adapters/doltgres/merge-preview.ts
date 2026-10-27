// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `knowledge-store/adapters/doltgres/merge-preview`
 * Purpose: Inspect native conflicts for a pinned committed pair rather than infer from displayed fields.
 * Scope: SQL protocol on an already-admitted connection; no capacity or mutation mechanism.
 * Invariants: Fail closed; no merge, DML, commit, reset or branch creation; metadata follows main.
 * Side-effects: IO (native reads and session-local checkout only)
 * Links: https://cognidao.org/work/items/spike.5016, https://cognidao.org/work/items/story.5029
 * @internal
 */
import type { ContributionMergePreview } from "../../domain/contribution-schemas.js";
import type { DoltWriteConnection } from "./session-admission.js";
import { escapeRef, escapeValue } from "./util.js";

export function unavailableMergePreview(
  contributionId: string
): ContributionMergePreview {
  return {
    contributionId,
    status: "unavailable",
    mainCommit: null,
    contributionCommit: null,
    checkedAt: new Date().toISOString(),
    reason: "native_unavailable",
    conflicts: [],
  };
}

/** Also used by the shared executor's reconciliation; never repairs dirty state. */
export async function previewMainIsClean(
  conn: DoltWriteConnection
): Promise<boolean> {
  const active = await conn.unsafe("SELECT active_branch() AS branch_name");
  if (active.length !== 1 || active[0]?.branch_name !== "main") return false;
  if ((await conn.unsafe("SELECT * FROM dolt.status LIMIT 1")).length)
    return false;
  const merge = await conn.unsafe("SELECT is_merging FROM dolt.merge_status");
  if (
    merge.length !== 1 ||
    ![false, "false", 0].includes(merge[0]?.is_merging as boolean)
  )
    return false;
  return !(await conn.unsafe("SELECT * FROM dolt.conflicts LIMIT 1")).length;
}

function hash(value: unknown): string | null {
  const scalar = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof scalar === "string" && /^[0-9a-v]{32}$/.test(scalar)
    ? scalar
    : null;
}

function count(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "bigint")
    return value >= BigInt(0) ? String(value) : undefined;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : undefined;
  return typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 20
    ? value
    : undefined;
}

async function nativeHead(
  conn: DoltWriteConnection,
  ref: string
): Promise<string | null> {
  const rows = await conn.unsafe(
    `SELECT dolt_hashof(${escapeRef(ref)}) AS commit_hash`
  );
  return rows.length === 1 ? hash(rows[0]?.commit_hash) : null;
}

async function snapshot(conn: DoltWriteConnection, id: string) {
  // Explicit checkout refreshes the pinned session; HEAD/main equality is also
  // required. A session that cannot refresh never certifies stale metadata.
  await conn.unsafe("SELECT dolt_checkout('main')");
  const mainCommit = await nativeHead(conn, "main");
  const observedCommit = await nativeHead(conn, "HEAD");
  if (!mainCommit || mainCommit !== observedCommit) return null;
  const rows = await conn.unsafe(
    `SELECT * FROM knowledge_contributions WHERE id = ${escapeValue(id)} LIMIT 1`
  );
  return { mainCommit, row: rows.length === 1 ? rows[0] : null };
}

export async function previewContributionMerge(
  conn: DoltWriteConnection,
  id: string
): Promise<ContributionMergePreview> {
  const result = unavailableMergePreview(id);
  if (!(await previewMainIsClean(conn)))
    return { ...result, reason: "dirty_main" };
  const before = await snapshot(conn, id);
  if (!before) return result;
  result.mainCommit = before.mainCommit;
  const rec = before.row;
  if (!rec) return { ...result, reason: "not_found" };
  if (rec.state !== "open")
    return { ...result, status: "changed", reason: "not_open" };
  if (!rec.head_commit || rec.commit_count === 0)
    return { ...result, reason: "empty" };
  const base = hash(rec.base_commit);
  const recordedHead = hash(rec.head_commit);
  if (
    !base ||
    !recordedHead ||
    typeof rec.branch !== "string" ||
    !rec.branch.startsWith("contrib/") ||
    !Number.isSafeInteger(Number(rec.commit_count)) ||
    Number(rec.commit_count) < 1
  )
    return { ...result, reason: "malformed_result" };
  const contributionCommit = await nativeHead(conn, rec.branch);
  result.contributionCommit = contributionCommit;
  if (!contributionCommit || contributionCommit !== recordedHead)
    return { ...result, status: "changed", reason: "head_changed" };

  // LIMIT bounds output only. The shared native executor owns the query's
  // caller deadline and retains capacity until native work actually settles.
  const rows = await conn.unsafe(
    `SELECT * FROM dolt_preview_merge_conflicts_summary(${escapeRef(before.mainCommit)}, ${escapeRef(contributionCommit)}) LIMIT 51`
  );
  if (rows.length > 50) return { ...result, reason: "malformed_result" };
  const conflicts: ContributionMergePreview["conflicts"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const dataConflicts = count(row.num_data_conflicts);
    const schemaConflicts = count(row.num_schema_conflicts);
    if (
      typeof row.table !== "string" ||
      !row.table ||
      row.table.length > 256 ||
      seen.has(row.table) ||
      dataConflicts === undefined ||
      schemaConflicts === undefined
    )
      return { ...result, reason: "malformed_result" };
    // A schema conflict can make the data count unknown. Other unknown counts,
    // or an alleged conflict row with no positive count, are not a clean proof.
    if (
      !(dataConflicts !== null && dataConflicts !== "0") &&
      !(schemaConflicts !== null && schemaConflicts !== "0")
    )
      return { ...result, reason: "malformed_result" };
    seen.add(row.table);
    conflicts.push({ table: row.table, dataConflicts, schemaConflicts });
  }

  const after = await snapshot(conn, id);
  const afterHead = await nativeHead(conn, rec.branch);
  if (
    !after ||
    after.mainCommit !== before.mainCommit ||
    afterHead !== contributionCommit ||
    !after.row ||
    after.row.state !== "open" ||
    after.row.branch !== rec.branch ||
    hash(after.row.head_commit) !== recordedHead ||
    hash(after.row.base_commit) !== base ||
    String(after.row.commit_count) !== String(rec.commit_count)
  )
    return { ...result, status: "changed", reason: "head_changed" };
  if (!(await previewMainIsClean(conn)))
    return { ...result, reason: "dirty_main" };
  return {
    ...result,
    status: conflicts.length ? "conflicted" : "clean",
    reason: null,
    conflicts,
    checkedAt: new Date().toISOString(),
  };
}
