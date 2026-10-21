// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/dao-goals`
 * Purpose: Coverage for the DAO goal list reader — `listActiveGoals` on the Doltgres + fake adapters — and the goal confidence exemption.
 * Scope: Fake postgres.js client; does not connect to live Doltgres.
 * Invariants: ONE_GOAL_LIST, MAX_THREE_GOALS, NO_GOALS_FAILS_LOUD (empty list, not an omission), goals excluded from confidence recompute.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/dao-goals.ts, packages/knowledge-store/src/adapters/doltgres/index.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "../src/adapters/fake/index.js";
import { MAX_ACTIVE_GOALS } from "../src/domain/dao-goals.js";
import {
  HypothesisMissingEvaluateAtError,
  TooManyActiveGoalsError,
} from "../src/port/knowledge-store.port.js";

type Row = Record<string, unknown>;

function goalRow(id: string, over: Row = {}): Row {
  return {
    id,
    entry_type: "goal",
    status: "draft",
    title: `Goal: ${id}`,
    content: `Statement for ${id}.\nKPI: x\nTarget: 1\nBy: 2026-12-31`,
    evaluate_at: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

/** Answers the goal read with `rows`, as main-plane Doltgres would. */
class FakeSql {
  readonly queries: string[] = [];
  constructor(private readonly rows: Row[]) {}
  async unsafe(query: string): Promise<Row[]> {
    this.queries.push(query);
    return this.rows;
  }
}

function adapterFor(rows: Row[]): {
  adapter: DoltgresKnowledgeStoreAdapter;
  fake: FakeSql;
} {
  const fake = new FakeSql(rows);
  return {
    adapter: new DoltgresKnowledgeStoreAdapter({ sql: fake as unknown as Sql }),
    fake,
  };
}

describe("DoltgresKnowledgeStoreAdapter.listActiveGoals", () => {
  it("returns [] when no goal is merged (caller renders it loudly)", async () => {
    const { adapter } = adapterFor([]);
    await expect(adapter.listActiveGoals()).resolves.toEqual([]);
  });

  it("returns 1–3 goals sorted by id with id, title, content, evaluateAt verbatim", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-b"),
      goalRow("goal-a"),
      goalRow("goal-c"),
    ]);
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-a", "goal-b", "goal-c"]);
    expect(goals[0]).toEqual({
      id: "goal-a",
      title: "Goal: goal-a",
      content: "Statement for goal-a.\nKPI: x\nTarget: 1\nBy: 2026-12-31",
      evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
    });
  });

  it("excludes deprecated rows, non-goal-prefixed ids and goal-loop hypotheses", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-live"),
      goalRow("goal-old", { status: "deprecated" }),
      goalRow("ship-faster"),
      // The goal-loop start route files `goal-<timestamp>` HYPOTHESIS rows;
      // those are loop targets, never DAO goals.
      goalRow("goal-2026-10-21T00-00-00-000Z", { entry_type: "hypothesis" }),
    ]);
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-live"]);
  });

  it("throws TooManyActiveGoalsError past the max — never truncates (MAX_THREE_GOALS)", async () => {
    const ids = ["goal-a", "goal-b", "goal-c", "goal-d"];
    const { adapter } = adapterFor(ids.map((id) => goalRow(id)));
    const err = await adapter.listActiveGoals().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyActiveGoalsError);
    expect((err as TooManyActiveGoalsError).goalIds).toEqual(ids);
    expect((err as TooManyActiveGoalsError).max).toBe(MAX_ACTIVE_GOALS);
    expect((err as Error).message).toContain("4 active DAO goals");
  });

  it("does not count deprecated rows toward the cap", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-a"),
      goalRow("goal-b"),
      goalRow("goal-c"),
      goalRow("goal-d", { status: "deprecated" }),
    ]);
    await expect(adapter.listActiveGoals()).resolves.toHaveLength(3);
  });

  it("reads the main-plane table only — one query, no branch checkout or AS OF (branch rows excluded)", async () => {
    const { adapter, fake } = adapterFor([]);
    await adapter.listActiveGoals();
    expect(fake.queries).toHaveLength(1);
    const q = fake.queries[0] as string;
    expect(q).toContain("FROM knowledge WHERE entry_type = 'goal'");
    expect(q).toContain("evaluate_at");
    expect(q).not.toMatch(/dolt_checkout|AS OF|contrib\//i);
  });
});

describe("FakeKnowledgeStoreAdapter — goal parity", () => {
  async function seed(
    store: FakeKnowledgeStoreAdapter,
    id: string,
    entryType = "goal"
  ) {
    return store.addKnowledge({
      id,
      domain: "strategy",
      title: `Goal: ${id}`,
      content: "statement",
      entryType,
      evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
      sourceType: "human",
    });
  }

  async function freshStore(): Promise<FakeKnowledgeStoreAdapter> {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "strategy", name: "strategy" });
    return store;
  }

  it("selects goal-* goal rows and enforces the same cap", async () => {
    const store = await freshStore();
    await expect(store.listActiveGoals()).resolves.toEqual([]);
    await seed(store, "goal-a");
    await seed(store, "goal-x", "hypothesis");
    expect((await store.listActiveGoals()).map((g) => g.id)).toEqual([
      "goal-a",
    ]);
    await seed(store, "goal-b");
    await seed(store, "goal-c");
    await seed(store, "goal-d");
    await expect(store.listActiveGoals()).rejects.toBeInstanceOf(
      TooManyActiveGoalsError
    );
  });

  it("rejects a goal without evaluateAt (its By: deadline)", async () => {
    const store = await freshStore();
    await expect(
      store.addKnowledge({
        id: "goal-undated",
        domain: "strategy",
        title: "Goal: undated",
        content: "statement",
        entryType: "goal",
        sourceType: "human",
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
  });

  it("leaves a goal's confidence alone on citation recompute", async () => {
    const store = await freshStore();
    const goal = await seed(store, "goal-a");
    // A supporting edge would bump any non-exempt row's confidence.
    await store.addKnowledge({
      id: "evidence-a",
      domain: "strategy",
      title: "Evidence a",
      content: "supports the goal",
      entryType: "finding",
      sourceType: "agent",
    });
    await store.addCitation({
      citingId: "evidence-a",
      citedId: "goal-a",
      citationType: "supports",
    });
    const resolver = new FakeEdoResolverAdapter(store);
    await expect(resolver.recomputeConfidence("goal-a")).resolves.toBe(
      goal.confidencePct
    );
    expect((await store.getKnowledge("goal-a"))?.confidencePct).toBe(
      goal.confidencePct
    );
  });
});
