// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-adapter`
 * Purpose: Focused unit coverage for Doltgres contribution adapter revision selection and metadata ordering.
 * Scope: Uses fake postgres.js clients; does not connect to Doltgres.
 * Invariants: CONTRIBUTION_DIFF_ANCHORED_TO_BASE, CONTRIBUTION_METADATA_BEFORE_BRANCH_DELETE.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts
 * @internal
 */

import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeContributionAdapter } from "../src/adapters/doltgres/contribution-adapter.js";
import type { Principal } from "../src/domain/contribution-schemas.js";
import { CitationTargetNotFoundError } from "../src/port/knowledge-store.port.js";

const record = {
  id: "contrib-agent-1-abc123",
  branch: "contrib/agent-1-abc123",
  base_commit: "base123",
  head_commit: "head123",
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

class FakeReservedSql {
  readonly queries: string[] = [];

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("dolt_hashof")) {
      return [{ dolt_hashof: "head123" }];
    }
    if (query.includes("dolt_commit")) {
      return [{ dolt_commit: ["{next456}"] }];
    }
    if (query.includes("FROM domains")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("dolt_merge")) {
      return [{ dolt_merge: ["merge123"] }];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    // cite-path lookups: both endpoints resolve, no incoming edges yet.
    if (query.includes("SELECT 1 FROM knowledge WHERE id")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("entry_type FROM knowledge")) {
      return [{ entry_type: "finding" }];
    }
    if (query.includes("source_type FROM knowledge")) {
      return [{ source_type: "external" }];
    }
    if (query.includes("citation_type FROM citations")) {
      return [];
    }
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "next456",
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
  readonly conn = new FakeReservedSql();

  constructor(
    private readonly contributionRecord: Record<string, unknown> = record
  ) {}

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

function adapterFor(fake: FakeSql): DoltgresKnowledgeContributionAdapter {
  return new DoltgresKnowledgeContributionAdapter({
    sql: fake as unknown as Sql,
  });
}

describe("DoltgresKnowledgeContributionAdapter", () => {
  it("anchors contribution diff to the recorded base and head commits", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'head123', 'knowledge')"
    );
  });

  it("uses base commit as both sides for diff when no branch commit exists", async () => {
    const fake = new FakeSql({ ...record, head_commit: null, commit_count: 0 });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'base123', 'knowledge')"
    );
  });

  it("normalizes persisted brace-wrapped refs before building diff refs", async () => {
    const fake = new FakeSql({
      ...record,
      base_commit: "{base123}",
      head_commit: "{head123}",
    });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'head123', 'knowledge')"
    );
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

    expect(commit.commitHash).toBe("next456");
    expect(fake.conn.queries).toContain(
      "SELECT dolt_hashof('contrib/agent-1-abc123') AS dolt_hashof"
    );
    expect(
      fake.conn.queries.some((query) =>
        query.includes("head_commit = 'head123'")
      )
    ).toBe(true);
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

    expect(commit.commitHash).toBe("next456");
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
  readonly queries: string[] = [];

  constructor(private readonly branchEntryTypes: Map<string, string>) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("dolt_hashof")) return [{ dolt_hashof: "head123" }];
    if (query.includes("dolt_commit")) return [{ dolt_commit: ["{next456}"] }];
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
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "next456",
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
