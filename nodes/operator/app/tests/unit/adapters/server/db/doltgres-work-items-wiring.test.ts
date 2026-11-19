// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/doltgres-work-items-wiring`
 * Purpose: Prove the production work-items adapter is built with a cite resolver (task.0086), takes the metric baseline port the container injects (story.0033) and carries the status-gate facts (task.0122).
 * Scope: Calls the real `getDoltgresWorkItemsAdapter()` with the Doltgres client builder mocked; no database, docker or network.
 * Invariants:
 *   - RESOLVER_IS_WIRED: the adapter carries an `entryResolver`, so a patch with cites is never refused as `cites_unsupported`.
 *   - RESOLVER_READS_OFF_THE_WRITER: the resolver reads on its own lazy width-one pool, not the writer or read client.
 *   - BASELINE_IS_INJECTED (story.0033): the adapter carries the caller's `metricBaseline` port; with none given it carries none, so a non-empty `moves` write is refused.
 *   - GATE_FACTS_ARE_WIRED (task.0122): the adapter carries the caller's `prFacts`, `prRepos` and `hubOrigin`, and an inbox-state port that reads on the cites pool: never the width-one writer whose lock the gate already holds, and never the read pool, which the adapter retires and replaces after a read error (bug.5649).
 *   - FAILS_WITHOUT_THE_WIRING: removing `entryResolver` from client.ts fails every test here.
 * Side-effects: none
 * Links: src/adapters/server/db/doltgres/client.ts, hub change-history-design
 * @internal
 */

import type { EntryResolver } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { built, resolverSql, inboxSql, resolver } = vi.hoisted(() => ({
  built: [] as { applicationName: string; max?: number; unsafe: unknown }[],
  resolverSql: { current: undefined as unknown },
  inboxSql: { current: undefined as unknown },
  resolver: { resolve: undefined as unknown as EntryResolver["resolve"] },
}));

vi.mock("@cogni/knowledge-store/adapters/doltgres", () => ({
  buildDoltgresClient: vi.fn(
    (opts: { applicationName: string; max?: number }) => {
      const refuse = () => {
        throw new Error(`fake SQL for ${opts.applicationName}`);
      };
      const unsafe = vi.fn(async () => [{ hash: "0".repeat(32) }]);
      const sql = Object.assign(refuse, {
        unsafe,
        options: { max: opts.max ?? 10 },
        reserve: refuse,
        begin: refuse,
        end: async () => undefined,
      });
      built.push({ ...opts, unsafe });
      return sql;
    }
  ),
}));

vi.mock("@cogni/shared-knowledge-store/adapters/doltgres", () => ({
  createDoltgresEntryResolver: vi.fn((sql: unknown) => {
    resolverSql.current = sql;
    return resolver;
  }),
  createDoltgresInboxStates: vi.fn((sql: unknown) => {
    inboxSql.current = sql;
    return { stateOf: vi.fn(async () => null) };
  }),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    DOLTGRES_URL: "postgres://doltgres.invalid/knowledge_operator",
    SERVICE_NAME: "app",
  }),
}));

describe("operator work-items adapter wiring (task.0086)", () => {
  beforeEach(() => {
    built.length = 0;
    resolverSql.current = undefined;
    inboxSql.current = undefined;
    resolver.resolve = vi.fn(async () => []);
    vi.resetModules();
  });

  async function adapter(deps?: {
    metricBaseline?: { latestObservationId: () => Promise<string | null> };
    prFacts?: { read: () => Promise<{ head: string; merged: boolean }> };
    prRepos?: readonly string[];
    hubOrigin?: string;
  }) {
    const { getDoltgresWorkItemsAdapter } = await import(
      "@/adapters/server/db/doltgres/client"
    );
    return getDoltgresWorkItemsAdapter(undefined, deps);
  }

  it("builds the adapter with the cite resolver set", async () => {
    const wired = await adapter();
    expect(
      (wired as unknown as { entryResolver?: unknown }).entryResolver
    ).toBe(resolver);
  });

  it("carries the metric baseline port the container injects, and none by default (story.0033)", async () => {
    const metricBaseline = { latestObservationId: vi.fn(async () => null) };
    const wired = await adapter({ metricBaseline });
    expect(
      (wired as unknown as { metricBaseline?: unknown }).metricBaseline
    ).toBe(metricBaseline);

    vi.resetModules();
    const bare = await adapter();
    expect(
      (bare as unknown as { metricBaseline?: unknown }).metricBaseline
    ).toBeUndefined();
  });

  it("does not refuse a patch with cites as cites_unsupported", async () => {
    const wired = await adapter();
    const refusal = await wired
      .patch(
        {
          id: "task.5999" as never,
          reason: "Cite an atom",
          cites: [{ id: "node-test-contract" }],
          set: { priority: 2 },
        },
        "actor:test"
      )
      .catch((error: unknown) => error);
    // The fake SQL fails the write session, but the cite rules passed first: a missing
    // resolver would answer CitesUnsupportedError before any SQL.
    expect((refusal as Error).name).not.toBe("CitesUnsupportedError");
  });

  it("reads cites on a dedicated lazy width-one pool, never on the writer", async () => {
    const wired = await adapter();
    expect(wired).toBeDefined();
    // Lazy: no cite pool exists until the resolver first reads.
    expect(
      built.filter((c) => c.applicationName.includes("cites"))
    ).toHaveLength(0);

    const sql = resolverSql.current as {
      unsafe(query: string): PromiseLike<unknown>;
    };
    await sql.unsafe("SELECT dolt_hashof('main') AS hash");

    const cites = built.filter((c) => c.applicationName.includes("cites"));
    expect(cites).toHaveLength(1);
    expect(cites[0]?.max).toBe(1);
    expect(cites[0]?.unsafe).toHaveBeenCalledWith(
      "SELECT dolt_hashof('main') AS hash"
    );
    const writer = built.find(
      (c) => c.applicationName === "cogni_work_items_app"
    );
    expect(writer?.unsafe).not.toHaveBeenCalled();
  });

  it("carries the gate facts the container injects and reads inbox state on the cites pool, not the read pool or the writer (task.0122, bug.5649)", async () => {
    const prFacts = {
      read: vi.fn(async () => ({ head: "a".repeat(40), merged: false })),
    };
    const wired = await adapter({
      prFacts,
      prRepos: ["cogni-dao/cogni"],
      hubOrigin: "https://test.cognidao.org",
    });
    const carried = wired as unknown as {
      prFacts?: unknown;
      prRepos?: unknown;
      hubOrigin?: unknown;
      inboxes?: unknown;
    };
    expect(carried.prFacts).toBe(prFacts);
    expect(carried.prRepos).toEqual(["cogni-dao/cogni"]);
    expect(carried.hubOrigin).toBe("https://test.cognidao.org");
    expect(carried.inboxes).toBeDefined();

    const sql = inboxSql.current as {
      unsafe(query: string): PromiseLike<unknown>;
    };
    await sql.unsafe("SELECT state, head_commit FROM knowledge_contributions");
    const cites = built.find((c) => c.applicationName.includes("cites"));
    expect(cites?.unsafe).toHaveBeenCalledWith(
      "SELECT state, head_commit FROM knowledge_contributions"
    );
    const reader = built.find(
      (c) => c.applicationName === "cogni_work_items_read_app"
    );
    expect(reader?.unsafe).not.toHaveBeenCalledWith(
      "SELECT state, head_commit FROM knowledge_contributions"
    );
    const writer = built.find(
      (c) => c.applicationName === "cogni_work_items_app"
    );
    expect(writer?.unsafe).not.toHaveBeenCalled();
  });

  it("leaves the repo pin and hub origin unset when the container injects none", async () => {
    const wired = await adapter();
    const carried = wired as unknown as {
      prRepos?: unknown;
      hubOrigin?: unknown;
    };
    expect(carried.prRepos).toBeUndefined();
    expect(carried.hubOrigin).toBeUndefined();
  });
});
