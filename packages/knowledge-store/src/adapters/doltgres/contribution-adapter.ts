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
 *   - EDO atomic-batch methods (createEdoHypothesis/Decision/Outcome) open a
 *     contrib branch and apply entry + N citations + (for outcomes) confidence
 *     recompute in one Dolt commit on the branch. Mirrors EdoCapability's
 *     four-beat semantics but on `contrib/*`, not `main` (EDO_BEARER_VIA_CONTRIB_BRANCH).
 * Side-effects: IO (database reads/writes, dolt branch ops)
 * Links: docs/design/knowledge-contribution-api.md, docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import { randomBytes } from "node:crypto";
import type { ReservedSql, Sql } from "postgres";
import {
  initializeConfidence,
  recomputeConfidence as recomputeConfidenceByPolicy,
} from "../../domain/confidence-policy.js";
import type {
  ContributionCommitRecord,
  ContributionDiffEntry,
  ContributionRecord,
  ContributionState,
  KnowledgeContributionEdit,
  Principal,
} from "../../domain/contribution-schemas.js";
import type { CitationType } from "../../domain/schemas.js";
import {
  HYPOTHESIS_TARGETED_EDGES,
  isWorkItemEndpointId,
} from "../../domain/schemas.js";
import {
  ContributionConflictError,
  ContributionNotFoundError,
  ContributionStateError,
  type CreateEdoDecisionInput,
  type CreateEdoHypothesisInput,
  type CreateEdoOutcomeInput,
  type KnowledgeContributionPort,
} from "../../port/contribution.port.js";
import {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  HypothesisMissingEvaluateAtError,
} from "../../port/knowledge-store.port.js";
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

// ---------------------------------------------------------------------------
// EDO atomic-batch helpers (mirror DoltgresKnowledgeStoreAdapter +
// DoltgresEdoResolverAdapter, but run on a reserved branch connection so
// inserts land on contrib/* not main).
// ---------------------------------------------------------------------------

function citationIdFor(
  citingId: string,
  citedId: string,
  type: CitationType
): string {
  return `${citingId}->${citedId}:${type}`;
}

function expectedCitedEntryTypeFor(type: CitationType): string | null {
  return HYPOTHESIS_TARGETED_EDGES.includes(type) ? "hypothesis" : null;
}

/**
 * Stamp the EDO write provenance from the contribution context. Mirrors
 * `applyEdit` for the contribution-edits path: source_type='external',
 * source_ref='contribution:<id>:<seq>'. Agents cannot override this — the
 * REST handler omits these fields from the wire schema.
 */
interface EdoBatchProvenance {
  sourceType: "external";
  sourceRef: string;
  sourceNode: string;
}

function edoBatchProvenance(
  contributionId: string,
  principal: Principal,
  seq: number
): EdoBatchProvenance {
  return {
    sourceType: "external",
    sourceRef: sourceRef(contributionId, seq),
    sourceNode: principal.id,
  };
}

async function insertKnowledgeRow(input: {
  conn: ReservedSql;
  id: string;
  domain: string;
  title: string;
  content: string;
  entryType: "hypothesis" | "decision" | "outcome";
  confidencePct: number;
  evaluateAt?: Date | null;
  resolutionStrategy?: string | null;
  tags?: string[];
  provenance: EdoBatchProvenance;
}): Promise<void> {
  const {
    conn,
    id,
    domain,
    title,
    content,
    entryType,
    confidencePct,
    evaluateAt,
    resolutionStrategy,
    tags,
    provenance,
  } = input;
  if (entryType === "hypothesis" && !evaluateAt) {
    throw new HypothesisMissingEvaluateAtError(id);
  }
  await assertDomainRegistered(conn, domain);
  await conn.unsafe(
    `INSERT INTO knowledge (id, domain, entity_id, title, content, entry_type, confidence_pct, source_type, source_ref, source_node, tags, evaluate_at, resolution_strategy) VALUES (${escapeValue(id)}, ${escapeValue(domain)}, NULL, ${escapeValue(title)}, ${escapeValue(content)}, ${escapeValue(entryType)}, ${escapeValue(confidencePct)}, ${escapeValue(provenance.sourceType)}, ${escapeValue(provenance.sourceRef)}, ${escapeValue(provenance.sourceNode)}, ${tags && tags.length > 0 ? escapeValue(tags) : "NULL"}, ${escapeValue(evaluateAt ?? null)}, ${escapeValue(resolutionStrategy ?? null)})`
  );
}

async function getKnowledgeEntryTypeOnConn(
  conn: ReservedSql,
  id: string
): Promise<string | null> {
  const rows = await conn.unsafe(
    `SELECT entry_type FROM knowledge WHERE id = ${escapeValue(id)} LIMIT 1`
  );
  if (rows.length === 0) return null;
  return (rows[0] as Record<string, unknown>).entry_type as string;
}

type CitationEndpoint =
  | { kind: "knowledge"; entryType: string; onBranch: boolean }
  | { kind: "work"; onBranch: false };

async function getKnowledgeEntryTypeOnMain(
  mainSql: Sql,
  id: string
): Promise<string | null> {
  const rows = await mainSql.unsafe(
    `SELECT entry_type FROM knowledge WHERE id = ${escapeValue(id)} LIMIT 1`
  );
  if (rows.length === 0) return null;
  return (rows[0] as Record<string, unknown>).entry_type as string;
}

async function workItemExistsOnMain(
  mainSql: Sql,
  id: string
): Promise<boolean> {
  const rows = await mainSql.unsafe(
    `SELECT 1 FROM work_items WHERE id = ${escapeValue(id)} LIMIT 1`
  );
  return rows.length > 0;
}

async function resolveCitationEndpoint(
  branchConn: ReservedSql,
  mainSql: Sql,
  id: string
): Promise<CitationEndpoint | null> {
  if (isWorkItemEndpointId(id)) {
    return (await workItemExistsOnMain(mainSql, id))
      ? { kind: "work", onBranch: false }
      : null;
  }

  const onBranch = await getKnowledgeEntryTypeOnConn(branchConn, id);
  if (onBranch !== null) {
    return { kind: "knowledge", entryType: onBranch, onBranch: true };
  }

  const onMain = await getKnowledgeEntryTypeOnMain(mainSql, id);
  return onMain !== null
    ? { kind: "knowledge", entryType: onMain, onBranch: false }
    : null;
}

function assertCitationEndpointPair(input: {
  citing: CitationEndpoint;
  cited: CitationEndpoint;
  citationType: CitationType;
  citingId: string;
  citedId: string;
}): void {
  const { citing, cited, citationType, citingId, citedId } = input;
  const workEndpointCount =
    (citing.kind === "work" ? 1 : 0) + (cited.kind === "work" ? 1 : 0);
  if (workEndpointCount > 0) {
    if (workEndpointCount !== 1) {
      throw new ContributionConflictError(
        `cite edge must connect exactly one work item and one knowledge entry: ${citingId} -> ${citedId}`
      );
    }
    if (citationType !== "tracks") {
      throw new ContributionConflictError(
        `work-item citation edge must use citation_type='tracks', got '${citationType}'`
      );
    }
    return;
  }

  if (citationType === "tracks") {
    throw new ContributionConflictError(
      "citation_type='tracks' requires exactly one work-item endpoint"
    );
  }
}

async function insertCitationRow(input: {
  conn: ReservedSql;
  mainSql: Sql;
  citingId: string;
  citedId: string;
  citationType: CitationType;
  context?: string;
  citedEndpoint?: CitationEndpoint;
}): Promise<{ id: string; citedEndpoint: CitationEndpoint }> {
  const {
    conn,
    mainSql,
    citingId,
    citedId,
    citationType,
    context,
    citedEndpoint,
  } = input;
  // CITATION_TARGET_EXISTS_AT_WRITE (main ∪ branch) + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE.
  const cited =
    citedEndpoint ?? (await resolveCitationEndpoint(conn, mainSql, citedId));
  if (cited === null) {
    throw new CitationTargetNotFoundError(citedId);
  }
  if (cited.kind === "work" && citationType !== "tracks") {
    throw new ContributionConflictError(
      `work-item citation edge must use citation_type='tracks', got '${citationType}'`
    );
  }
  const expected =
    cited.kind === "knowledge" ? expectedCitedEntryTypeFor(citationType) : null;
  if (
    expected !== null &&
    cited.kind === "knowledge" &&
    cited.entryType !== expected
  ) {
    throw new CitationTypeMismatchError(
      citationType,
      citedId,
      cited.entryType,
      expected
    );
  }
  const id = citationIdFor(citingId, citedId, citationType);
  try {
    await conn.unsafe(
      `INSERT INTO citations (id, citing_id, cited_id, citation_type, context) VALUES (${escapeValue(id)}, ${escapeValue(citingId)}, ${escapeValue(citedId)}, ${escapeValue(citationType)}, ${escapeValue(context ?? null)})`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.toLowerCase().includes("duplicate")) throw e;
    // Already exists — idempotent.
  }
  return { id, citedEndpoint: cited };
}

/**
 * Recompute confidence on a single knowledge row using its 1-hop incoming
 * citations, on the branch connection. Mirrors
 * `DoltgresEdoResolverAdapter.recomputeConfidence` but pins to the reserved
 * connection so the recompute reads + writes inside the contrib branch.
 */
async function recomputeConfidenceOnConn(
  conn: ReservedSql,
  entryId: string
): Promise<number> {
  const entryRows = await conn.unsafe(
    `SELECT source_type FROM knowledge WHERE id = ${escapeValue(entryId)} LIMIT 1`
  );
  if (entryRows.length === 0) {
    throw new Error(`recomputeConfidence: entry '${entryId}' not found`);
  }
  const sourceType = (entryRows[0] as Record<string, unknown>)
    .source_type as string;
  const incoming = await conn.unsafe(
    `SELECT citation_type FROM citations WHERE cited_id = ${escapeValue(entryId)} AND citation_type <> 'tracks'`
  );
  const citations = incoming.map((r) => ({
    citationType: (r as Record<string, unknown>).citation_type as string,
  }));
  const next = recomputeConfidenceByPolicy(
    {
      sourceType: sourceType as
        | "human"
        | "agent"
        | "analysis_signal"
        | "external"
        | "derived",
    },
    citations
  ).confidencePct;
  await conn.unsafe(
    `UPDATE knowledge SET confidence_pct = ${escapeValue(next)} WHERE id = ${escapeValue(entryId)}`
  );
  return next;
}

async function applyEdit(input: {
  conn: ReservedSql;
  mainSql: Sql;
  contributionId: string;
  principal: Principal;
  seq: number;
  edit: KnowledgeContributionEdit;
}): Promise<void> {
  const { conn, mainSql, contributionId, principal, seq, edit } = input;
  const ref = sourceRef(contributionId, seq);
  const sourceNode = principal.id;
  if (edit.op === "delete") {
    // DELETE_IS_CLEAN: dead knowledge is removed from the live table, not
    // soft-flagged. Dolt's version history preserves the row's content, every
    // commit, and the contributor chain — the log IS the tombstone (audit +
    // attribution survive). The delete itself is attributed via the
    // surrounding contribution commit (principal + source_ref).
    await assertKnowledgeRowExists(conn, edit.targetRowId);
    // DAG safety: refuse if a live row cites this one — deleting would dangle
    // that inbound edge. Repoint/remove those citations first, or refine the
    // target in place instead of deleting.
    const inbound = (await conn.unsafe(
      `SELECT citing_id FROM citations WHERE cited_id = ${escapeValue(edit.targetRowId)} LIMIT 5`
    )) as Array<{ citing_id: string }>;
    if (inbound.length > 0) {
      const citers = inbound.map((r) => r.citing_id).join(", ");
      throw new ContributionConflictError(
        `cannot delete '${edit.targetRowId}': cited by ${citers}. Remove or repoint those edges first, or refine the entry in place.`
      );
    }
    // Cascade the dead entry's OWN outbound edges (its claims about others),
    // then the row. Inbound is guaranteed empty by the guard above.
    await conn.unsafe(
      `DELETE FROM citations WHERE citing_id = ${escapeValue(edit.targetRowId)}`
    );
    await conn.unsafe(
      `DELETE FROM knowledge WHERE id = ${escapeValue(edit.targetRowId)}`
    );
    return;
  }

  if (edit.op === "cite") {
    const citing = await resolveCitationEndpoint(conn, mainSql, edit.citingId);
    if (citing === null) {
      throw new CitationTargetNotFoundError(edit.citingId);
    }
    const cited = await resolveCitationEndpoint(conn, mainSql, edit.citedId);
    if (cited === null) {
      throw new CitationTargetNotFoundError(edit.citedId);
    }
    assertCitationEndpointPair({
      citing,
      cited,
      citationType: edit.citationType,
      citingId: edit.citingId,
      citedId: edit.citedId,
    });
    const workEndpointCount =
      (citing.kind === "work" ? 1 : 0) + (cited.kind === "work" ? 1 : 0);
    if (workEndpointCount === 1) {
      const knowledgeId =
        citing.kind === "knowledge" ? edit.citingId : edit.citedId;
      const mainEntryType = await getKnowledgeEntryTypeOnMain(
        mainSql,
        knowledgeId
      );
      if (mainEntryType === null) {
        throw new CitationTargetNotFoundError(knowledgeId);
      }
    }
    const { citedEndpoint } = await insertCitationRow({
      conn,
      mainSql,
      citingId: edit.citingId,
      citedId: edit.citedId,
      citationType: edit.citationType,
      context: edit.context,
      citedEndpoint: cited,
    });
    // Recompute the cited row's confidence inside the branch so the reviewer
    // sees the supports/contradicts effect pre-merge (mirrors the EDO outcome
    // path). Skip when the target lives only on `main` (cross-plane cite,
    // bug.5024): there is no branch row to UPDATE, and the edge recomputes on
    // main's own write path. The edge itself is still recorded on the branch.
    if (
      citedEndpoint.kind === "knowledge" &&
      citedEndpoint.onBranch &&
      edit.citationType !== "tracks"
    ) {
      await recomputeConfidenceOnConn(conn, edit.citedId);
    }
    return;
  }

  await assertDomainRegistered(conn, edit.entry.domain);
  const confidencePct = initializeConfidence(
    {
      sourceType: "external",
    },
    { principalKind: principal.kind }
  ).confidencePct;
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
            mainSql: this.sql,
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

  /**
   * Open a contrib branch and write hypothesis row + N evidence_for citations
   * + one Dolt commit on the branch. Mirrors `create()`'s branch lifecycle
   * (open branch, apply rows, commit, checkout main, write metadata commit)
   * and `EdoCapability.hypothesize()`'s atomic shape (entry + edges + commit).
   */
  async createEdoHypothesis(
    input: CreateEdoHypothesisInput
  ): Promise<ContributionRecord> {
    return this.createEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "hypothesis",
        confidencePct,
        evaluateAt: input.entry.evaluateAt,
        resolutionStrategy: input.entry.resolutionStrategy ?? null,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      for (const evidenceId of input.evidenceForIds ?? []) {
        await insertCitationRow({
          conn,
          mainSql: this.sql,
          citingId: input.entry.id,
          citedId: evidenceId,
          citationType: "evidence_for",
        });
      }
      return {
        editCount: 1 + (input.evidenceForIds?.length ?? 0),
        message: input.message,
      };
    });
  }

  /**
   * Open a contrib branch and write decision row + derives_from citation +
   * one Dolt commit on the branch. The hypothesis being cited must already
   * exist on `main` (the branch base).
   */
  async createEdoDecision(
    input: CreateEdoDecisionInput
  ): Promise<ContributionRecord> {
    return this.createEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "decision",
        confidencePct,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      await insertCitationRow({
        conn,
        mainSql: this.sql,
        citingId: input.entry.id,
        citedId: input.derivesFromHypothesisId,
        citationType: "derives_from",
      });
      return { editCount: 2, message: input.message };
    });
  }

  /**
   * Open a contrib branch and write outcome row + validates/invalidates
   * citation + recompute hypothesis confidence + one Dolt commit on the
   * branch. The cited hypothesis must already exist on `main`.
   */
  async createEdoOutcome(
    input: CreateEdoOutcomeInput
  ): Promise<ContributionRecord> {
    return this.createEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "outcome",
        confidencePct,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      await insertCitationRow({
        conn,
        mainSql: this.sql,
        citingId: input.entry.id,
        citedId: input.hypothesisId,
        citationType: input.edge,
        context: `resolved by external contribution`,
      });
      await recomputeConfidenceOnConn(conn, input.hypothesisId);
      return { editCount: 2, message: input.message };
    });
  }

  /**
   * Shared branch-lifecycle wrapper for the three EDO atomic-batch ops.
   * Opens a contrib branch, runs `applyBatch` on the reserved connection,
   * commits, then writes the contribution metadata row on main with the
   * same shape as `create()`. Reviewer reads the branch via `diff(id)`.
   */
  private async createEdoBatch<
    T extends {
      principal: Principal;
      message: string;
      idempotencyKey?: string;
    },
  >(
    input: T,
    applyBatch: (ctx: {
      conn: ReservedSql;
      contributionId: string;
    }) => Promise<{ editCount: number; message: string }>
  ): Promise<ContributionRecord> {
    const slug = principalSlug(input.principal);
    const sid = shortId();
    const contributionId = `contrib-${slug}-${sid}`;
    const branch = `contrib/${slug}-${sid}`;

    return await withReserved(this.sql, async (conn) => {
      const baseCommit = await currentHash(conn, "main");
      await conn.unsafe(
        `SELECT dolt_checkout('-b', ${escapeRef(branch)}, 'main')`
      );

      const { editCount, message } = await applyBatch({ conn, contributionId });
      const commitMessage = contributionMessage(slug, message);
      const commitResult = await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(commitMessage)})`
      );
      const headCommit = parseDoltResult(
        commitResult[0] as Record<string, unknown>,
        "dolt_commit"
      );

      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(
        `INSERT INTO knowledge_contributions (id, branch, state, principal_id, principal_kind, message, base_commit, head_commit, commit_count, idempotency_key) VALUES (${escapeValue(contributionId)}, ${escapeValue(branch)}, 'open', ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(input.message)}, ${escapeValue(baseCommit)}, ${escapeValue(headCommit)}, 1, ${escapeValue(input.idempotencyKey ?? null)})`
      );
      const ref = sourceRef(contributionId, 1);
      const authSource =
        input.principal.kind === "agent" ? "bearer" : "session";
      await conn.unsafe(
        `INSERT INTO knowledge_contribution_commits (contribution_id, seq, commit_hash, principal_id, principal_kind, auth_source, message, edit_count, source_ref) VALUES (${escapeValue(contributionId)}, 1, ${escapeValue(headCommit)}, ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(authSource)}, ${escapeValue(input.message)}, ${editCount}, ${escapeValue(ref)})`
      );
      await conn.unsafe(
        `SELECT dolt_commit('-Am', ${escapeValue(metaMessage(contributionId))})`
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
            mainSql: this.sql,
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

  /**
   * COMPOUNDING_VIA_ONE_OPEN_CONTRIBUTION_PER_PRINCIPAL.
   * Return the principal's oldest open contribution, or null. The service
   * uses this to decide append-vs-create on EDO writes so a multi-step
   * hypothesis -> decision -> outcome chain compounds onto one branch
   * instead of sprawling into N parallel contributions.
   */
  async findOpenForPrincipal(
    principalId: string
  ): Promise<ContributionRecord | null> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM knowledge_contributions WHERE state = 'open' AND principal_id = ${escapeValue(principalId)} ORDER BY created_at ASC LIMIT 1`
    );
    if (rows.length === 0) return null;
    return mapRecord(rows[0] as Record<string, unknown>);
  }

  async appendEdoHypothesis(
    input: CreateEdoHypothesisInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    return this.appendEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "hypothesis",
        confidencePct,
        evaluateAt: input.entry.evaluateAt,
        resolutionStrategy: input.entry.resolutionStrategy ?? null,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      for (const evidenceId of input.evidenceForIds ?? []) {
        await insertCitationRow({
          conn,
          mainSql: this.sql,
          citingId: input.entry.id,
          citedId: evidenceId,
          citationType: "evidence_for",
        });
      }
      return {
        editCount: 1 + (input.evidenceForIds?.length ?? 0),
        message: input.message,
      };
    });
  }

  async appendEdoDecision(
    input: CreateEdoDecisionInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    return this.appendEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "decision",
        confidencePct,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      await insertCitationRow({
        conn,
        mainSql: this.sql,
        citingId: input.entry.id,
        citedId: input.derivesFromHypothesisId,
        citationType: "derives_from",
      });
      return { editCount: 2, message: input.message };
    });
  }

  async appendEdoOutcome(
    input: CreateEdoOutcomeInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    return this.appendEdoBatch(input, async ({ conn, contributionId }) => {
      const provenance = edoBatchProvenance(contributionId, input.principal, 1);
      const confidencePct = initializeConfidence(
        {
          sourceType: provenance.sourceType,
        },
        { principalKind: input.principal.kind }
      ).confidencePct;
      await insertKnowledgeRow({
        conn,
        id: input.entry.id,
        domain: input.entry.domain,
        title: input.entry.title,
        content: input.entry.content,
        entryType: "outcome",
        confidencePct,
        ...(input.entry.tags !== undefined ? { tags: input.entry.tags } : {}),
        provenance,
      });
      await insertCitationRow({
        conn,
        mainSql: this.sql,
        citingId: input.entry.id,
        citedId: input.hypothesisId,
        citationType: input.edge,
        context: `resolved by external contribution`,
      });
      await recomputeConfidenceOnConn(conn, input.hypothesisId);
      return { editCount: 2, message: input.message };
    });
  }

  /**
   * Shared branch-append wrapper for the three EDO append ops. Mirrors
   * `appendCommit` (concurrency-guarded checkout + commit on branch + UPDATE
   * contribution row) while applying the EDO atomic batch via callback
   * (same callback shape as `createEdoBatch` so create + append share row-
   * writing logic at the call site). Pre-merge invariant unchanged: every
   * EDO row sits on a contrib branch; only session-cookie merge promotes
   * to main.
   */
  private async appendEdoBatch<
    T extends {
      principal: Principal;
      message: string;
      contributionId: string;
    },
  >(
    input: T,
    applyBatch: (ctx: {
      conn: ReservedSql;
      contributionId: string;
    }) => Promise<{ editCount: number; message: string }>
  ): Promise<ContributionRecord> {
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

        const { editCount, message } = await applyBatch({
          conn,
          contributionId: input.contributionId,
        });
        const commitMessage = contributionMessage(
          principalSlug(input.principal),
          message
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
          `INSERT INTO knowledge_contribution_commits (contribution_id, seq, commit_hash, principal_id, principal_kind, auth_source, message, edit_count, source_ref) VALUES (${escapeValue(input.contributionId)}, ${seq}, ${escapeValue(commitHash)}, ${escapeValue(input.principal.id)}, ${escapeValue(input.principal.kind)}, ${escapeValue(authSource)}, ${escapeValue(message)}, ${editCount}, ${escapeValue(ref)})`
        );
        const metadataMessage = metaMessage(input.contributionId, seq);
        await conn.unsafe(
          `SELECT dolt_commit('-Am', ${escapeValue(metadataMessage)})`
        );

        const rows = await conn.unsafe(
          `SELECT * FROM knowledge_contributions WHERE id = ${escapeValue(input.contributionId)} LIMIT 1`
        );
        return mapRecord(rows[0] as Record<string, unknown>);
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
    const toRef = rec.headCommit ?? rec.baseCommit;
    const rows = await this.sql.unsafe(
      `SELECT * FROM dolt_diff(${escapeRef(rec.baseCommit)}, ${escapeRef(toRef)}, 'knowledge')`
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
