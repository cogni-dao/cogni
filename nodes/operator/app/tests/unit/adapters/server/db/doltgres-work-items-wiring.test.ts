// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/doltgres-work-items-wiring`
 * Purpose: Prove the production work-items adapter is built with a cite resolver (task.0086).
 * Scope: Calls the real `getDoltgresWorkItemsAdapter()` with the Doltgres client builder mocked; no database, docker or network.
 * Invariants:
 *   - RESOLVER_IS_WIRED: the adapter carries an `entryResolver`, so a patch with cites is never refused as `cites_unsupported`.
 *   - RESOLVER_READS_OFF_THE_WRITER: the resolver reads on its own lazy width-one pool, not the writer or read client.
 *   - FAILS_WITHOUT_THE_WIRING: removing `entryResolver` from client.ts fails every test here.
 * Side-effects: none
 * Links: src/adapters/server/db/doltgres/client.ts, hub change-history-design
 * @internal
 */

import type { EntryResolver } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { built, resolverSql, resolver } = vi.hoisted(() => ({
  built: [] as { applicationName: string; max?: number; unsafe: unknown }[],
  resolverSql: { current: undefined as unknown },
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
    resolver.resolve = vi.fn(async () => []);
    vi.resetModules();
  });

  async function adapter() {
    const { getDoltgresWorkItemsAdapter } = await import(
      "@/adapters/server/db/doltgres/client"
    );
    return getDoltgresWorkItemsAdapter();
  }

  it("builds the adapter with the cite resolver set", async () => {
    const wired = await adapter();
    expect(
      (wired as unknown as { entryResolver?: unknown }).entryResolver
    ).toBe(resolver);
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
});
