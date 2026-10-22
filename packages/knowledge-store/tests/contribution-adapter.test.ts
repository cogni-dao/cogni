// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-adapter`
 * Purpose: Focused unit coverage for Doltgres contribution adapter revision selection and metadata ordering.
 * Scope: Uses fake postgres.js clients; does not connect to Doltgres.
 * Invariants: CONTRIBUTION_DIFF_ANCHORED_TO_BASE, CONTRIBUTION_METADATA_BEFORE_BRANCH_DELETE,
 *   HYPOTHESIS_HAS_EVALUATE_AT (update + patch), MERGE_GATES_ON_RAW_ROWS, MERGE_HEAD_CAS.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts
 * @internal
 */

import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeContributionAdapter } from "../src/adapters/doltgres/contribution-adapter.js";
import {
  KnowledgeContributionEditSchema,
  type Principal,
} from "../src/domain/contribution-schemas.js";
import { ContributionConflictError } from "../src/port/contribution.port.js";
import {
  CitationTargetNotFoundError,
  HypothesisMissingEvaluateAtError,
  KnowledgeWriteOutcomeUnknownError,
} from "../src/port/knowledge-store.port.js";

const record = {
  id: "contrib-agent-1-abc123",
  branch: "contrib/agent-1-abc123",
  base_commit: "base123",
  head_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  commit_count: 3,
  state: "open",
  principal_kind: "agent",
  principal_id: "agent-1",
  message: "branch edit",
  merged_commit: null,
  closed_reason: null,
  idempotency_key: null,
  created_at: new Date("2026-05-19T00:00:00.000Z"),
  resolved_at: null,
  resolved_by: null,
} satisfies Record<string, unknown>;

const reviewer: Principal = {
  id: "user-1",
  kind: "user",
  role: "admin",
};

// Stateful native metadata fixture: identity, private branch ownership and clean
// reconciliation are observed rather than bypassing the released executor.
class NativeState {
  active = "main";
  dirty = false;
  observe(query: string): Record<string, unknown>[] | undefined {
    if (query.includes("current_database()"))
      return [{ dolt_writer_database: "knowledge_test" }];
    if (query.includes("active_branch()"))
      return [{ branch_name: this.active }];
    if (query.includes("dolt_checkout(")) {
      const args = [...query.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      this.active = args[0] === "-b" ? (args[1] ?? "") : (args[0] ?? "");
      return [{ dolt_checkout: 0 }];
    }
    if (query.includes("dolt.merge_status")) return [{ is_merging: false }];
    if (query.includes("AS commit_hash"))
      return [{ commit_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
    if (query.includes("dolt_merge_base"))
      return [{ merge_base: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }];
    if (query.startsWith("SELECT hash, fast_forward"))
      return [{ hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", conflicts: 0 }];
    if (query.includes("FROM dolt.status"))
      return this.dirty ? [{ table_name: "knowledge_contributions" }] : [];
    if (/^(INSERT|UPDATE|DELETE)/.test(query)) this.dirty = true;
    if (/^(INSERT INTO|UPDATE) knowledge_contribution/.test(query)) {
      if (!this.active.startsWith("dolt-op/"))
        throw new Error("Metadata DML escaped private operation branch");
      this.dirty = true;
    }
    if (query.includes("dolt_commit") || query.includes("dolt_reset"))
      this.dirty = false;
    return undefined;
  }
}

/** The target row's stored deadline state, as `assertResultingDeadline` reads it. */
type StoredDeadline = {
  entry_type: string;
  evaluate_at: Date | null;
} | null;

class FakeReservedSql {
  private readonly native = new NativeState();
  readonly queries: string[] = [];

  constructor(
    private readonly hasUseWhen = true,
    private readonly stored: StoredDeadline = {
      entry_type: "finding",
      evaluate_at: null,
    }
  ) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    const native = this.native.observe(query);
    if (native !== undefined) return native;
    // Admission control takes a session advisory lock before any branch work
    // (bug.5391); a fake that cannot answer it would fail every write as busy.
    if (query.includes("pg_try_advisory_lock"))
      return [{ pg_try_advisory_lock: true }];
    if (query.includes("pg_advisory_unlock"))
      return [{ pg_advisory_unlock: true }];
    if (query.includes("dolt_hashof")) {
      return [{ dolt_hashof: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
    }
    if (query.includes("dolt_commit")) {
      return [{ dolt_commit: ["{bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"] }];
    }
    if (query.includes("FROM domains")) {
      return [{ "?column?": 1 }];
    }
    if (
      query.includes("information_schema.columns") &&
      query.includes("'use_when'")
    ) {
      return this.hasUseWhen ? [{ "?column?": 1 }] : [];
    }
    if (query.includes("dolt_merge")) {
      return [{ dolt_merge: ["cccccccccccccccccccccccccccccccc"] }];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contributions")) {
      return [record];
    }
    if (query.includes("SELECT entry_type, evaluate_at FROM knowledge")) {
      return this.stored ? [this.stored] : [];
    }
    // cite-path lookups: both endpoints resolve, no incoming edges yet.
    if (query.includes("SELECT 1 FROM knowledge WHERE id")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("entry_type FROM knowledge")) {
      return [{ entry_type: "finding" }];
    }
    if (
      query.includes("source_type, entry_type, confidence_pct FROM knowledge")
    ) {
      return [
        { source_type: "external", entry_type: "finding", confidence_pct: 30 },
      ];
    }
    if (query.includes("citation_type FROM citations")) {
      return [];
    }
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          principal_kind: "agent",
          principal_id: "agent-1",
          auth_source: "bearer",
          message: "append",
          edit_count: 1,
          source_ref: "contribution:contrib-agent-1-abc123:4",
          created_at: new Date("2026-05-19T00:00:00.000Z"),
        },
      ];
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class FakeSql {
  readonly queries: string[] = [];
  readonly conn: FakeReservedSql;

  constructor(
    private readonly contributionRecord: Record<string, unknown> = record,
    hasUseWhen = true,
    stored?: StoredDeadline
  ) {
    this.conn = new FakeReservedSql(hasUseWhen, stored);
  }

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) {
      return [this.contributionRecord];
    }
    if (query.includes("dolt_diff")) {
      return [];
    }
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

// Injects specific dolt_diff rows per table so diff() output can be asserted.
class FakeDiffSql {
  readonly queries: string[] = [];
  readonly conn = new FakeReservedSql();

  constructor(
    private readonly knowledgeRows: Record<string, unknown>[],
    private readonly citationRows: Record<string, unknown>[]
  ) {}

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("dolt_diff") && query.includes("'citations'"))
      return this.citationRows;
    if (query.includes("dolt_diff")) return this.knowledgeRows;
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

// A ReservedSql whose dolt_merge() returns the full Doltgres
// (hash, fast_forward, conflicts, message) record — the real shape a merge of a
// non-trivial branch produces — parameterized so tests can drive both a clean
// merge and a conflicted one. Abort returns its own benign record.
class FakeMergeReservedSql {
  private readonly native = new NativeState();
  readonly queries: string[] = [];

  constructor(
    private readonly mergeRow: unknown[],
    // When set, the branch merge THROWS this raw message (Doltgres @autocommit
    // rollback behaviour) instead of returning a row — the real prod path.
    private readonly throwOnMerge?: string
  ) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    const native = this.native.observe(query);
    if (native !== undefined) return native;
    // Admission control takes a session advisory lock before any branch work
    // (bug.5391); a fake that cannot answer it would fail every write as busy.
    if (query.includes("pg_try_advisory_lock"))
      return [{ pg_try_advisory_lock: true }];
    if (query.includes("pg_advisory_unlock"))
      return [{ pg_advisory_unlock: true }];
    if (query.includes("dolt_merge('--abort')")) {
      return [{ dolt_merge: ["", "0", "0", "aborted"] }];
    }
    if (query.includes("dolt_merge(")) {
      if (this.throwOnMerge) throw new Error(this.throwOnMerge);
      return [{ dolt_merge: this.mergeRow }];
    }
    if (query.includes("dolt_commit")) {
      return [{ dolt_commit: ["{bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"] }];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contributions")) return [record];
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class FakeMergeSql {
  readonly queries: string[] = [];

  constructor(readonly conn: FakeMergeReservedSql) {}

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) {
      return [record];
    }
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

function independentWriter(fake: {
  unsafe(query: string): Promise<Record<string, unknown>[]>;
  reserve(): Promise<ReservedSql>;
}): Sql {
  return {
    unsafe: fake.unsafe.bind(fake),
    reserve: fake.reserve.bind(fake),
    end: async () => undefined,
  } as unknown as Sql;
}

function adapterFor(
  fake: FakeSql | FakeDiffSql | FakeMergeSql
): DoltgresKnowledgeContributionAdapter {
  return new DoltgresKnowledgeContributionAdapter({
    sql: fake as unknown as Sql,
    branchSql: independentWriter(fake),
  });
}

describe("DoltgresKnowledgeContributionAdapter", () => {
  it("anchors contribution diff to the recorded base and head commits", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(
      fake.queries.some((q) =>
        q.includes(
          "dolt_diff('base123', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'knowledge')"
        )
      )
    ).toBe(true);
  });

  it("uses base commit as both sides for diff when no branch commit exists", async () => {
    const fake = new FakeSql({ ...record, head_commit: null, commit_count: 0 });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(
      fake.queries.some((q) =>
        q.includes("dolt_diff('base123', 'base123', 'knowledge')")
      )
    ).toBe(true);
  });

  it("surfaces citation adds as links and suppresses phantom modified (bug.5004)", async () => {
    // knowledge diff returns a `modified` row whose DISPLAYED fields are identical
    // (a citation confidence-recompute side-effect); citations diff returns one add.
    const fake = new FakeDiffSql(
      [
        {
          diff_type: "modified",
          from_id: "operator-agent-orientation",
          to_id: "operator-agent-orientation",
          from_title: "orientation",
          to_title: "orientation",
          from_content: "body",
          to_content: "body",
          from_entry_type: "reference",
          to_entry_type: "reference",
          from_domain: "operator",
          to_domain: "operator",
        },
      ],
      [
        {
          diff_type: "added",
          to_id: "cit-1",
          to_citing_id: "operator-node-catalog",
          to_cited_id: "operator-agent-orientation",
          to_citation_type: "extends",
        },
      ]
    );

    const entries = await adapterFor(fake).diff("contrib-agent-1-abc123");

    // the phantom `modified` on the cited entry is dropped; only the link remains
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      changeType: "citation_added",
      after: {
        citingId: "operator-node-catalog",
        citedId: "operator-agent-orientation",
        citationType: "extends",
      },
    });
    // and the citations table is actually diffed
    expect(
      fake.queries.some((q) =>
        q.includes(
          "dolt_diff('base123', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'citations')"
        )
      )
    ).toBe(true);
  });

  it("normalizes persisted brace-wrapped refs before building diff refs", async () => {
    const fake = new FakeSql({
      ...record,
      base_commit: "{base123}",
      head_commit: "{aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}",
    });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(
      fake.queries.some((q) =>
        q.includes(
          "dolt_diff('base123', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'knowledge')"
        )
      )
    ).toBe(true);
  });

  it("commits merge metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
    });

    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'merged'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-merge: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("surfaces a merge conflict as a typed error and aborts, leaving the branch open (bug.5120)", async () => {
    // Doltgres reports a data conflict as a non-zero `conflicts` field in the
    // dolt_merge record WITHOUT throwing. The adapter must detect it, abort the
    // half-applied merge, and raise a typed ContributionConflictError rather
    // than blindly marking the contribution merged and letting the later
    // dolt_commit throw an opaque 500.
    const conn = new FakeMergeReservedSql(["", "0", "2", "conflicts found"]);
    const fake = new FakeMergeSql(conn);

    await expect(
      adapterFor(fake).merge({
        contributionId: "contrib-agent-1-abc123",
        principal: reviewer,
      })
    ).rejects.toThrow(/conflict/i);

    // it aborted the conflicted merge so the working set is clean for next time
    expect(conn.queries.some((q) => q.includes("dolt_merge('--abort')"))).toBe(
      true
    );
    // and it never marked the contribution merged or deleted the branch
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      false
    );
    expect(conn.queries.some((q) => q.includes("dolt_branch('-D'"))).toBe(
      false
    );
  });

  it("merges a branch whose dolt_merge returns the full clean record (no false conflict on intra-branch citations)", async () => {
    // A real branch carrying entries plus intra-branch citation edges produces
    // the full (hash, fast_forward, conflicts=0, message) record. The new
    // conflict parsing must treat conflicts=0 as success — not misread a later
    // field as a conflict — and complete the merge without aborting.
    const conn = new FakeMergeReservedSql([
      "merge999",
      "0",
      "0",
      "merge successful",
    ]);
    const fake = new FakeMergeSql(conn);

    const result = await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
    });

    expect(result.commitHash).toBe("merge999");
    expect(conn.queries.some((q) => q.includes("dolt_merge('--abort')"))).toBe(
      false
    );
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      true
    );
    expect(conn.queries.some((q) => q.includes("dolt_branch('-D'"))).toBe(true);
  });

  it("keeps a thrown native merge outcome unknown and private without replay (bug.5120)", async () => {
    // Doltgres throws on a conflicted merge with @autocommit on. The raw text
    // ("@@dolt_allow_commit_conflicts", branch refs, dolt_conflicts tables) must
    // NOT reach the admin — only a plain what-happened + how-to-fix message.
    const raw =
      "dolt_merge failed for contrib/x: Merge conflict detected, @autocommit transaction rolled back. set @@dolt_allow_commit_conflicts = 1";
    const conn = new FakeMergeReservedSql([], raw);
    const fake = new FakeMergeSql(conn);

    const err = await adapterFor(fake)
      .merge({ contributionId: "contrib-agent-1-abc123", principal: reviewer })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(err).toBeTruthy();
    expect(err).toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    if (!(err instanceof KnowledgeWriteOutcomeUnknownError)) throw err;
    expect(err.retryable).toBe(false);
    expect(err.receipt).toMatchObject({
      code: "knowledge_write_outcome_unknown",
      retryable: false,
      lookup: {
        operationId: err.operationId,
        branch: "main",
        commitHash: null,
      },
    });
    expect(err.operationId).not.toBe("");
    expect(
      conn.queries.filter(
        (q) => q === "SELECT dolt_merge('contrib/agent-1-abc123')"
      )
    ).toHaveLength(1);
    expect(conn.queries.some((q) => q.includes("dolt_branch('-D'"))).toBe(
      false
    );
    // no raw Dolt/SQL leakage
    expect(err?.message).not.toMatch(
      /dolt_merge|@@dolt|autocommit|dolt_conflicts/i
    );
    expect(err?.message).not.toContain("contrib/x");
    // conflicted branch is never marked merged
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      false
    );
  });

  it("commits close metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).close({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
      reason: "superseded",
    });

    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'closed'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-close: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("accepts Dolt commit refs returned with and without braces while appending", async () => {
    const fake = new FakeSql();

    const commit = await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "append",
      edits: [
        {
          op: "insert",
          entry: {
            id: "row-1",
            domain: "meta",
            title: "row",
            content: "content",
          },
        },
      ],
    });

    expect(commit.commitHash).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const checkout = fake.conn.queries.indexOf(
      "SELECT dolt_checkout('contrib/agent-1-abc123')"
    );
    const head = fake.conn.queries.indexOf(
      "SELECT dolt_hashof('HEAD') AS commit_hash",
      checkout + 1
    );
    const edit = fake.conn.queries.findIndex((q) =>
      q.startsWith("INSERT INTO knowledge (")
    );
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(head).toBeGreaterThan(checkout);
    expect(edit).toBeGreaterThan(head);
    expect(
      fake.conn.queries.some((query) =>
        query.includes("head_commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")
      )
    ).toBe(true);
  });

  it("strips dangerous control chars from content + title on the insert-edit write (bug.5062)", async () => {
    const fake = new FakeSql();
    const chr = (code: number): string => String.fromCharCode(code);
    // Newline is legitimate markdown and must survive; the form feed (0x0c),
    // bell (0x07), and NUL (0x00) must be stripped before storage.
    const dirtyContent = `keep${chr(0x0a)}drop${chr(0x0c)}end${chr(0x00)}`;
    const dirtyTitle = `Title${chr(0x07)} bell`;

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "insert dirty content",
      edits: [
        {
          op: "insert",
          entry: {
            id: "row-dirty",
            domain: "meta",
            title: dirtyTitle,
            content: dirtyContent,
          },
        },
      ],
    });

    const insert = fake.conn.queries.find((q) =>
      q.startsWith("INSERT INTO knowledge (")
    );
    expect(insert).toBeDefined();
    const sql = insert as string;
    // No raw dangerous control bytes reached the SQL...
    expect(sql).not.toContain(chr(0x0c));
    expect(sql).not.toContain(chr(0x07));
    expect(sql).not.toContain(chr(0x00));
    // ...the stripped fragments are now adjacent...
    expect(sql).toContain("dropend");
    expect(sql).toContain("Title bell");
    // ...and the legitimate newline is preserved.
    expect(sql).toContain(`keep${chr(0x0a)}drop`);
  });

  it("persists use_when on an insert edit (explicit column list regression)", async () => {
    // The adapter writes knowledge rows with hand-written column lists, so a
    // new column is silently dropped unless every list is updated. That is
    // exactly what shipped and had to be caught on a live candidate: the API
    // accepted `useWhen` and the stored row came back null.
    const fake = new FakeSql();

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "new atom with a retrieval trigger",
      edits: [
        {
          op: "insert",
          entry: {
            id: "shelf-one-axis",
            domain: "method",
            title: "A shelf sorts on one axis",
            content: "Body.",
            useWhen: "designing a knowledge domain set",
          },
        },
      ],
    });

    const insert = fake.conn.queries.find(
      (q) => q.startsWith("INSERT INTO knowledge ") && q.includes("use_when")
    );
    expect(insert).toBeDefined();
    expect(insert).toContain("designing a knowledge domain set");
  });

  it.each([
    "goal",
    "hypothesis",
  ])("inserts a %s edit with evaluateAt + resolutionStrategy (bug.5504)", async (entryType) => {
    // A goal or bet proposed through a focused inbox carries its own deadline;
    // before bug.5504 the wire schema had no field for it, so neither could be
    // added through /contributions.
    const fake = new FakeSql();
    const edit = KnowledgeContributionEditSchema.parse({
      op: "insert",
      entry: {
        id: "goal-cognition-probe",
        domain: "strategy",
        title: "Goal: cognition probe renders verbatim",
        content: "Statement: probe.",
        entryType,
        evaluateAt: "2026-12-31T00:00:00.000Z",
        resolutionStrategy: "manual",
      },
    });

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "propose a goal",
      edits: [edit],
    });

    const insert = fake.conn.queries.find((q) =>
      q.startsWith("INSERT INTO knowledge ")
    );
    expect(insert).toContain("evaluate_at, resolution_strategy");
    expect(insert).toContain(`'${entryType}'`);
    expect(insert).toContain("'2026-12-31T00:00:00.000Z', 'manual')");
  });

  it.each([
    "goal",
    "hypothesis",
  ])("rejects a %s insert edit without evaluateAt (HYPOTHESIS_HAS_EVALUATE_AT)", async (entryType) => {
    const fake = new FakeSql();
    await expect(
      adapterFor(fake).appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "propose a goal without a date",
        edits: [
          {
            op: "insert",
            entry: {
              id: "goal-undated",
              domain: "strategy",
              title: "Goal: undated",
              content: "Statement: no date.",
              entryType,
            },
          },
        ],
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
    expect(
      fake.conn.queries.some((q) => q.startsWith("INSERT INTO knowledge "))
    ).toBe(false);
  });

  it("does not recompute a goal's confidence when a supports edge cites it", async () => {
    // Goals are human commitments: citations never move their confidence.
    const fake = new FakeSql();
    const original = fake.conn.unsafe.bind(fake.conn);
    fake.conn.unsafe = async (query: string) => {
      if (
        query.includes("source_type, entry_type, confidence_pct FROM knowledge")
      ) {
        fake.conn.queries.push(query);
        return [
          { source_type: "external", entry_type: "goal", confidence_pct: 70 },
        ];
      }
      return original(query);
    };
    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "cite a goal",
      edits: [
        {
          op: "cite",
          citingId: "evidence-row",
          citedId: "goal-a",
          citationType: "supports",
        },
      ],
    });
    expect(
      fake.conn.queries.some((q) =>
        q.startsWith("UPDATE knowledge SET confidence_pct")
      )
    ).toBe(false);
  });

  it("persists use_when on an update edit", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "move the trigger out of content",
      edits: [
        {
          op: "update",
          targetRowId: "shelf-one-axis",
          entry: {
            id: "shelf-one-axis",
            domain: "method",
            title: "A shelf sorts on one axis",
            content: "Body without the trigger line.",
            useWhen: "designing a knowledge domain set",
          },
        },
      ],
    });

    const update = fake.conn.queries.find(
      (q) => q.startsWith("UPDATE knowledge SET") && q.includes("use_when")
    );
    expect(update).toBeDefined();
    expect(update).toContain("designing a knowledge domain set");
  });

  it("updates a historical branch that predates the optional use_when column", async () => {
    const fake = new FakeSql(record, false);

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "refresh a long-lived visual",
      edits: [
        {
          op: "update",
          targetRowId: "node-birth-fastlane",
          entry: {
            id: "node-birth-fastlane",
            domain: "substrate",
            title: "Generated PR fast lane status",
            content: "Current visual.",
          },
        },
      ],
    });

    const update = fake.conn.queries.find((q) =>
      q.startsWith("UPDATE knowledge SET")
    );
    expect(update).toBeDefined();
    expect(update).not.toContain("use_when");
    expect(update).toContain("Current visual.");
  });

  it("inserts into a historical branch that predates the optional use_when column", async () => {
    const fake = new FakeSql(record, false);

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "append a historical-branch atom",
      edits: [
        {
          op: "insert",
          entry: {
            id: "historical-branch-atom",
            domain: "substrate",
            title: "Historical branch atom",
            content: "Current content.",
          },
        },
      ],
    });

    const insert = fake.conn.queries.find((q) =>
      q.startsWith("INSERT INTO knowledge (")
    );
    expect(insert).toBeDefined();
    expect(insert).not.toContain("use_when");
    expect(insert).toContain("Current content.");
  });

  it("writes NULL use_when when the edit omits it", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "atom without a trigger",
      edits: [
        {
          op: "insert",
          entry: {
            id: "no-trigger",
            domain: "method",
            title: "No trigger here",
            content: "Body.",
          },
        },
      ],
    });

    const insert = fake.conn.queries.find((q) =>
      q.startsWith("INSERT INTO knowledge ")
    );
    expect(insert).toContain("use_when");
    expect(insert).toMatch(/,\s*NULL,/);
  });

  it("applies a cite edit as a citations insert + cited-row confidence recompute", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "link synthesis to atom",
      edits: [
        {
          op: "cite",
          citingId: "oss-cap-eval-harness",
          citedId: "oss-promptfoo",
          citationType: "supports",
        },
      ],
    });

    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'oss-cap-eval-harness'") &&
          q.includes("'oss-promptfoo'") &&
          q.includes("'supports'")
      )
    ).toBe(true);
    // the edge recomputes the cited row's confidence inside the branch
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("UPDATE knowledge SET confidence_pct") &&
          q.includes("'oss-promptfoo'")
      )
    ).toBe(true);
  });

  // bug.5024: a branch contribution citing a row that was merged to main AFTER
  // the branch forked. The target resolves on main but not on the branch HEAD;
  // the cite must still succeed (main ∪ branch resolution) and skip the
  // branch-local confidence recompute (no branch row to UPDATE).
  it("accepts a cross-plane cite (target on main, absent from branch) and skips recompute", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["cicd-agent-playbook", "finding"]]),
      branchEntryTypes: new Map([["oss-langgraph", "finding"]]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    const commit = await adapter.appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "cite a merged-main atom from a branch entry",
      edits: [
        {
          op: "cite",
          citingId: "oss-langgraph",
          citedId: "cicd-agent-playbook",
          citationType: "supports",
        },
      ],
    });

    expect(commit.commitHash).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    // The edge is recorded on the branch even though the target is main-only.
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'cicd-agent-playbook'")
      )
    ).toBe(true);
    // main was consulted for the cited entry_type when the branch lookup missed.
    expect(
      fake.queries.some(
        (q) =>
          q.includes("entry_type FROM knowledge") &&
          q.includes("'cicd-agent-playbook'")
      )
    ).toBe(true);
    // No branch-local recompute: the cited row isn't on the branch to UPDATE.
    expect(
      fake.conn.queries.some((q) =>
        q.includes("UPDATE knowledge SET confidence_pct")
      )
    ).toBe(false);
    expect(
      fake.conn.queries.some((q) => q.includes("source_type FROM knowledge"))
    ).toBe(false);
  });

  it("accepts a work-item tracking cite and skips confidence recompute", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["work-knowledge-write-planes", "finding"]]),
      branchEntryTypes: new Map(),
      mainWorkItemIds: new Set(["task.5017"]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await adapter.appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "link work item to durable knowledge",
      edits: [
        {
          op: "cite",
          citingId: "task.5017",
          citedId: "work-knowledge-write-planes",
          citationType: "tracks",
        },
      ],
    });

    expect(
      fake.queries.some(
        (q) => q.includes("FROM work_items") && q.includes("'task.5017'")
      )
    ).toBe(true);
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'task.5017'") &&
          q.includes("'work-knowledge-write-planes'") &&
          q.includes("'tracks'")
      )
    ).toBe(true);
    expect(
      fake.conn.queries.some((q) =>
        q.includes("UPDATE knowledge SET confidence_pct")
      )
    ).toBe(false);
  });

  it("rejects a work-item tracking cite when the work item is absent from main", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["work-knowledge-write-planes", "finding"]]),
      branchEntryTypes: new Map(),
      mainWorkItemIds: new Set(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "link missing work item",
        edits: [
          {
            op: "cite",
            citingId: "task.9999",
            citedId: "work-knowledge-write-planes",
            citationType: "tracks",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("rejects a work-item tracking cite when the knowledge endpoint is branch-only", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map(),
      branchEntryTypes: new Map([["branch-only-entry", "finding"]]),
      mainWorkItemIds: new Set(["task.5017"]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "link branch-only knowledge to work",
        edits: [
          {
            op: "cite",
            citingId: "branch-only-entry",
            citedId: "task.5017",
            citationType: "tracks",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("throws CitationTargetNotFoundError when the cited row is on neither branch nor main", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map(),
      branchEntryTypes: new Map(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "cite a bogus id",
        edits: [
          {
            op: "cite",
            citingId: "oss-langgraph",
            citedId: "does-not-exist-anywhere",
            citationType: "supports",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });
});

describe("goal deadline on update + patch (HYPOTHESIS_HAS_EVALUATE_AT · task.5294)", () => {
  const goalStored = {
    entry_type: "goal",
    evaluate_at: new Date("2026-12-31T00:00:00.000Z"),
  };
  const findingStored = { entry_type: "finding", evaluate_at: null };

  async function append(
    fake: FakeSql,
    edit: Parameters<
      DoltgresKnowledgeContributionAdapter["appendCommit"]
    >[0]["edits"][number]
  ) {
    return adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "goal deadline edit",
      edits: [edit],
    });
  }

  const knowledgeUpdate = (fake: FakeSql) =>
    fake.conn.queries.find((q) => q.startsWith("UPDATE knowledge SET"));

  it("refuses a patch that retypes a row to goal with no deadline, writing nothing", async () => {
    const fake = new FakeSql(record, true, findingStored);
    await expect(
      append(fake, {
        op: "patch",
        targetRowId: "ship-faster",
        entry: { entryType: "goal" },
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
    expect(knowledgeUpdate(fake)).toBeUndefined();
  });

  it("lets a patch retype to goal when it carries the deadline, and persists it", async () => {
    const fake = new FakeSql(record, true, findingStored);
    await append(fake, {
      op: "patch",
      targetRowId: "ship-faster",
      entry: {
        entryType: "goal",
        evaluateAt: "2027-03-31T00:00:00.000Z",
        resolutionStrategy: "metric:prs-merged",
      },
    });
    const update = knowledgeUpdate(fake);
    expect(update).toContain("entry_type = 'goal'");
    expect(update).toContain("evaluate_at = '2027-03-31T00:00:00.000Z'");
    expect(update).toContain("resolution_strategy = 'metric:prs-merged'");
  });

  it("moves a goal's deadline with a patch that names only evaluateAt", async () => {
    const fake = new FakeSql(record, true, goalStored);
    await append(fake, {
      op: "patch",
      targetRowId: "goal-ship",
      entry: { evaluateAt: "2027-06-30T00:00:00.000Z" },
    });
    expect(knowledgeUpdate(fake)).toContain(
      "evaluate_at = '2027-06-30T00:00:00.000Z'"
    );
  });

  it("refuses an update that retypes a row to goal with no deadline", async () => {
    const fake = new FakeSql(record, true, findingStored);
    await expect(
      append(fake, {
        op: "update",
        targetRowId: "ship-faster",
        entry: {
          id: "ship-faster",
          domain: "strategy",
          title: "Ship faster",
          content: "statement",
          entryType: "goal",
        },
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
    expect(knowledgeUpdate(fake)).toBeUndefined();
  });

  it("persists evaluateAt and resolutionStrategy on an update (no longer dropped)", async () => {
    const fake = new FakeSql(record, true, goalStored);
    await append(fake, {
      op: "update",
      targetRowId: "goal-ship",
      entry: {
        id: "goal-ship",
        domain: "strategy",
        title: "Ship faster",
        content: "statement",
        entryType: "goal",
        evaluateAt: "2027-01-15T00:00:00.000Z",
        resolutionStrategy: "metric:prs-merged",
      },
    });
    const update = knowledgeUpdate(fake);
    expect(update).toContain("evaluate_at = '2027-01-15T00:00:00.000Z'");
    expect(update).toContain("resolution_strategy = 'metric:prs-merged'");
  });

  it("keeps a goal's stored deadline when an update omits evaluateAt (never nulls it)", async () => {
    const fake = new FakeSql(record, true, goalStored);
    await append(fake, {
      op: "update",
      targetRowId: "goal-ship",
      entry: {
        id: "goal-ship",
        domain: "strategy",
        title: "Ship faster",
        content: "statement",
        entryType: "goal",
        tags: ["retagged"],
      },
    });
    const update = knowledgeUpdate(fake);
    expect(update).toBeDefined();
    expect(update).not.toContain("evaluate_at");
  });

  it("still answers not-found for an update or patch on a missing row", async () => {
    const fake = new FakeSql(record, true, null);
    await expect(
      append(fake, {
        op: "patch",
        targetRowId: "nope",
        entry: { useWhen: "never" },
      })
    ).rejects.toThrow(/knowledge row not found/);
  });
});

describe("raw changed rows + merge head CAS (MERGE_GATES_ON_RAW_ROWS · MERGE_HEAD_CAS)", () => {
  it("names a goal row the display diff hides (tags-only update) plus citation endpoints", async () => {
    const fake = new FakeDiffSql(
      [
        {
          diff_type: "modified",
          from_id: "goal-ship",
          to_id: "goal-ship",
          from_title: "Ship faster",
          to_title: "Ship faster",
          from_content: "statement",
          to_content: "statement",
          from_entry_type: "goal",
          to_entry_type: "goal",
          from_domain: "strategy",
          to_domain: "strategy",
        },
      ],
      [
        {
          diff_type: "added",
          to_id: "cit-1",
          to_citing_id: "decision-x",
          to_cited_id: "goal-ship",
        },
        {
          diff_type: "removed",
          from_id: "cit-2",
          from_citing_id: "goal-old",
          from_cited_id: "finding-y",
        },
      ]
    );
    const adapter = adapterFor(fake);

    // The display diff drops the tags-only goal change (bug.5004 filter) ...
    const display = await adapter.diff("contrib-agent-1-abc123");
    expect(display.some((e) => e.rowId === "goal-ship")).toBe(false);

    // ... the raw read does not.
    const changes = await adapter.changedRows("contrib-agent-1-abc123");
    expect(changes).toEqual({
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      knowledgeIds: ["goal-ship"],
      citingIds: ["decision-x", "goal-old"],
      citedIds: ["goal-ship", "finding-y"],
    });
    expect(
      fake.queries.some((q) =>
        q.includes(
          "SELECT from_id, to_id FROM dolt_diff('base123', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'knowledge')"
        )
      )
    ).toBe(true);
  });

  it("refuses a merge whose head moved after authorization, before dolt_merge", async () => {
    const conn = new FakeMergeReservedSql(["merge999", "0", "0", "ok"]);
    const fake = new FakeMergeSql(conn);

    await expect(
      adapterFor(fake).merge({
        contributionId: "contrib-agent-1-abc123",
        principal: reviewer,
        expectedHeadCommit: "dddddddddddddddddddddddddddddddd",
      })
    ).rejects.toBeInstanceOf(ContributionConflictError);
    expect(conn.queries.some((q) => q.includes("dolt_merge("))).toBe(false);
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      false
    );
  });

  it("merges when the authorized head is still the head (brace-insensitive)", async () => {
    const conn = new FakeMergeReservedSql(["merge999", "0", "0", "ok"]);
    const fake = new FakeMergeSql(conn);

    const result = await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
      expectedHeadCommit: "{aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}",
    });
    expect(result.commitHash).toBe("merge999");
  });
});

/**
 * Fakes that distinguish the branch (reserved connection) plane from the merged
 * `main` (pool) plane so the cross-plane cite path (bug.5024) can be exercised.
 * `entry_type FROM knowledge` reads resolve against the per-plane id maps; the
 * citing-row existence check (`SELECT 1 ...`) always resolves on the branch.
 */
function idFromQuery(query: string): string | undefined {
  return query.match(/id = '([^']+)'/)?.[1];
}

class CrossPlaneFakeReservedSql {
  private readonly native = new NativeState();
  readonly queries: string[] = [];

  constructor(private readonly branchEntryTypes: Map<string, string>) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    const native = this.native.observe(query);
    if (native !== undefined) return native;
    // Admission control takes a session advisory lock before any branch work
    // (bug.5391); a fake that cannot answer it would fail every write as busy.
    if (query.includes("pg_try_advisory_lock"))
      return [{ pg_try_advisory_lock: true }];
    if (query.includes("pg_advisory_unlock"))
      return [{ pg_advisory_unlock: true }];
    if (query.includes("dolt_hashof"))
      return [{ dolt_hashof: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
    if (query.includes("dolt_commit"))
      return [{ dolt_commit: ["{bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"] }];
    if (query.includes("SELECT 1 FROM knowledge WHERE id"))
      return [{ "?column?": 1 }];
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.branchEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    if (query.includes("source_type FROM knowledge"))
      return [{ source_type: "external" }];
    if (query.includes("citation_type FROM citations")) return [];
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          principal_kind: "agent",
          principal_id: "agent-1",
          auth_source: "bearer",
          message: "append",
          edit_count: 1,
          source_ref: "contribution:contrib-agent-1-abc123:4",
          created_at: new Date("2026-05-19T00:00:00.000Z"),
        },
      ];
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class CrossPlaneFakeSql {
  readonly queries: string[] = [];
  readonly conn: CrossPlaneFakeReservedSql;
  private readonly mainEntryTypes: Map<string, string>;
  private readonly mainWorkItemIds: Set<string>;

  constructor(opts: {
    mainEntryTypes: Map<string, string>;
    branchEntryTypes: Map<string, string>;
    mainWorkItemIds?: Set<string>;
  }) {
    this.mainEntryTypes = opts.mainEntryTypes;
    this.mainWorkItemIds = opts.mainWorkItemIds ?? new Set();
    this.conn = new CrossPlaneFakeReservedSql(opts.branchEntryTypes);
  }

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("FROM work_items")) {
      return this.mainWorkItemIds.has(idFromQuery(query) ?? "")
        ? [{ "?column?": 1 }]
        : [];
    }
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.mainEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    if (query.includes("dolt_diff")) return [];
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}
