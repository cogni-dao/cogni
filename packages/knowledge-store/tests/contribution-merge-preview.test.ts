// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-merge-preview`
 * Purpose: Check native-preview result policy through the public adapter method.
 * Scope: Unit doubles only. Does not prove native execution or session lifetime.
 * Invariants: Displayed diffs never establish mergeability; errors never become clean.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/spike.5016
 * @internal
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { DoltgresKnowledgeContributionAdapter } from "../src/adapters/doltgres/contribution-adapter.js";
import type { DoltBranchSessionRunner } from "../src/adapters/doltgres/session-admission.js";

const main = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const metadata = {
  id: "contrib-agent-abcd",
  branch: "contrib/agent-abcd",
  base_commit: main,
  head_commit: head,
  commit_count: 1,
  state: "open",
  principal_kind: "agent",
  principal_id: "agent",
  message: "review me",
  merged_commit: null,
  closed_reason: null,
  idempotency_key: null,
  created_at: "2026-10-26T00:00:00Z",
  resolved_at: null,
  resolved_by: null,
};

function fixture(rows: Record<string, unknown>[] = []) {
  const queries: string[] = [];
  let state = { ...metadata };
  let mainHash = main;
  let afterPreview = () => {};
  let failure = false;
  const conn = {
    async unsafe(query: string) {
      queries.push(query);
      if (query.includes("active_branch()")) return [{ branch_name: "main" }];
      if (query.includes("dolt_checkout")) return [{ dolt_checkout: 0 }];
      if (query.includes("dolt.merge_status")) return [{ is_merging: false }];
      if (query.includes("dolt.status") || query.includes("dolt.conflicts"))
        return [];
      if (query.includes("FROM knowledge_contributions")) return [state];
      if (query.includes("dolt_hashof"))
        return [{ commit_hash: query.includes("'contrib/") ? head : mainHash }];
      if (query.includes("dolt_preview_merge_conflicts_summary")) {
        if (failure) throw new Error("unsupported native function");
        afterPreview();
        return rows;
      }
      throw new Error(`unexpected query: ${query}`);
    },
  };
  const session = {
    assertIndependentReadClient() {},
    async run(
      _operation: string,
      fn: (c: typeof conn, g: unknown, o: unknown) => Promise<unknown>,
      options: unknown
    ) {
      expect(options).toMatchObject({ awaitSettlement: true });
      return fn(conn, {}, { registerReconciliation() {} });
    },
  } as unknown as DoltBranchSessionRunner;
  const adapter = new DoltgresKnowledgeContributionAdapter({
    sql: {
      unsafe() {
        throw new Error("ordinary reader must remain independent");
      },
    } as unknown as Sql,
    writerSession: session,
  });
  return {
    adapter,
    queries,
    moveMain() {
      afterPreview = () => {
        mainHash = "cccccccccccccccccccccccccccccccc";
      };
    },
    close() {
      afterPreview = () => {
        state = { ...state, state: "closed" };
      };
    },
    malformedHead() {
      state = { ...state, head_commit: "not-a-hash" };
    },
    unsupported() {
      failure = true;
    },
  };
}

describe("native contribution preview", () => {
  it("checks immutable native hashes and returns a clean committed pair", async () => {
    const f = fixture();
    expect(await f.adapter.previewMerge(metadata.id)).toMatchObject({
      status: "clean",
      mainCommit: main,
      contributionCommit: head,
      conflicts: [],
    });
    expect(
      f.queries.some((q) =>
        q.includes(`dolt_preview_merge_conflicts_summary('${main}', '${head}')`)
      )
    ).toBe(true);
    expect(
      f.queries.some((q) =>
        /INSERT|UPDATE|DELETE|dolt_merge\(|dolt_reset|dolt_commit|dolt_branch\(/i.test(
          q
        )
      )
    ).toBe(false);
  });
  it("reports hidden-table and schema conflicts including unknown data count", async () => {
    const f = fixture([
      {
        table: "knowledge_contributions",
        num_data_conflicts: "1",
        num_schema_conflicts: "0",
      },
      {
        table: "knowledge",
        num_data_conflicts: null,
        num_schema_conflicts: "1",
      },
    ]);
    expect(await f.adapter.previewMerge(metadata.id)).toMatchObject({
      status: "conflicted",
      conflicts: [
        {
          table: "knowledge_contributions",
          dataConflicts: "1",
          schemaConflicts: "0",
        },
        { table: "knowledge", dataConflicts: null, schemaConflicts: "1" },
      ],
    });
  });
  it.each([
    "moveMain",
    "close",
  ] as const)("never returns clean after %s", async (change) => {
    const f = fixture();
    f[change]();
    expect((await f.adapter.previewMerge(metadata.id)).status).toBe("changed");
  });
  it.each([
    [
      {
        table: "knowledge",
        num_data_conflicts: null,
        num_schema_conflicts: "0",
      },
    ],
    [{ table: "knowledge", num_data_conflicts: -1, num_schema_conflicts: "0" }],
    [
      {
        table: "knowledge",
        num_data_conflicts: Number.MAX_SAFE_INTEGER + 1,
        num_schema_conflicts: "0",
      },
    ],
    Array.from({ length: 51 }, () => ({
      table: "knowledge",
      num_data_conflicts: "1",
      num_schema_conflicts: "0",
    })),
  ])("fails closed on malformed or unbounded summary %#", async (...input) => {
    const f = fixture(input);
    expect((await f.adapter.previewMerge(metadata.id)).status).toBe(
      "unavailable"
    );
  });
  it.each([
    "malformedHead",
    "unsupported",
  ] as const)("fails closed for %s", async (change) => {
    const f = fixture();
    f[change]();
    expect((await f.adapter.previewMerge(metadata.id)).status).toBe(
      "unavailable"
    );
  });
});
