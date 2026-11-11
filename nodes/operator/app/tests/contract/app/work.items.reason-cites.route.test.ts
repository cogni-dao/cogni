// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.reason-cites.route`
 * Purpose: Prove the PATCH route refuses a missing reason and bad cites over HTTP with nothing written (task.0086).
 * Scope: Real route handler and real facade. A missing reason and cites with no resolver run the real
 *   `DoltgresWorkItemAdapter` over a SQL stub that must never run; an unknown cite and a failed resolver use a store
 *   that throws the package's error classes (the adapter resolves cites inside its write session). No database.
 * Invariants:
 *   - REASON_REQUIRED: a PATCH with no reason is 400 with an issue at `reason`; the store is never reached.
 *   - CITES_ARE_CODED: an unknown cite id → 400 `cite_unresolved`; cites with no resolver wired → 400 `cites_unsupported`;
 *     a failed resolver → 503 `cite_resolver_unavailable`.
 *   - NOTHING_WRITTEN: where the real adapter runs, no SQL runs.
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts, src/app/api/v1/work/items/_errors.ts, hub change-history-design
 * @internal
 */

import {
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "@cogni/work-items";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";

const { state, sqlCalls } = vi.hoisted(() => ({
  state: { store: undefined as unknown },
  sqlCalls: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-11-10T00:00:00Z")) },
      config: { unhandledErrorPolicy: "respond_500" },
      workItemQuery: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        get: vi.fn().mockResolvedValue(null),
      },
      doltgresWorkItems: state.store,
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

function stubSql(): Sql {
  const refuse = (...args: unknown[]) => {
    sqlCalls(args);
    throw new Error("SQL must not run for a refused reason or cite");
  };
  return Object.assign(refuse, {
    unsafe: refuse,
    reserve: refuse,
    begin: refuse,
    end: async () => undefined,
  }) as unknown as Sql;
}

/** The real adapter with no resolver wired: its cite rules refuse before any lock or SQL. */
function realAdapterWithoutResolver(): DoltgresWorkItemAdapter {
  return new DoltgresWorkItemAdapter(stubSql(), { readClient: stubSql() });
}

/**
 * The adapter resolves cites inside its write session, so a resolver verdict cannot run over a SQL
 * stub. These stores throw the package's own error classes, as the adapter does when it refuses.
 */
function storeThatRefuses(error: Error) {
  return { patch: vi.fn().mockRejectedValue(error) };
}

const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("PATCH reason and cites over HTTP (task.0086)", () => {
  beforeEach(() => {
    sqlCalls.mockReset();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    state.store = realAdapterWithoutResolver();
  });

  it("refuses a PATCH with no reason: 400, an issue at reason, nothing written", async () => {
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch(patch({ set: { priority: 2 } }));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("invalid input");
        expect(
          body.issues.map((issue: { path: string[] }) => issue.path[0])
        ).toContain("reason");
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("refuses a reason over 25 words: 400, nothing written", async () => {
    const reason = Array.from({ length: 26 }, () => "why").join(" ");
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch(patch({ reason, set: { priority: 2 } }));
        expect(res.status).toBe(400);
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("answers 400 cite_unresolved for an unknown cite id, nothing written", async () => {
    const store = storeThatRefuses(new EntryUnresolvedError(["no-such-atom"]));
    state.store = store;
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch(
          patch({
            reason: "Cite a missing atom",
            cites: [{ id: "no-such-atom" }],
            set: { priority: 2 },
          })
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          errorCode: "cite_unresolved",
          ids: ["no-such-atom"],
        });
      },
    });
    expect(store.patch).toHaveBeenCalledTimes(1);
  });

  it("answers 400 cites_unsupported when no resolver is wired, nothing written", async () => {
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch(
          patch({
            reason: "Cite with no resolver",
            cites: [{ id: "node-test-contract" }],
            set: { priority: 2 },
          })
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          errorCode: "cites_unsupported",
        });
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("answers 503 cite_resolver_unavailable when the resolver fails, nothing written", async () => {
    state.store = storeThatRefuses(
      new EntryResolverUnavailableError("knowledge pool down")
    );
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch(
          patch({
            reason: "Cite while the hub is down",
            cites: [{ id: "node-test-contract" }],
            set: { priority: 2 },
          })
        );
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          errorCode: "cite_resolver_unavailable",
        });
      },
    });
  });
});
