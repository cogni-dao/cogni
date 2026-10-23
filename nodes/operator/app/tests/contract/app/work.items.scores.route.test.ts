// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.scores.route`
 * Purpose: Prove the operator `scores` write path has ONE enforcer and ONE allow-list, and that a valid
 *   create → read → patch → clear round trip flows through the real routes and facade (story.5111).
 * Scope: Real route handlers + real facade. Rejections run the real `DoltgresWorkItemAdapter` configured
 *   with the operator's `workItemScoreEvidenceHosts(GRAFANA_URL)` over a SQL stub that must never be
 *   called; the round trip runs an in-memory store. Does not touch a database.
 * Invariants:
 *   - SCORES_ONE_ENFORCER: the adapter's `parseWorkItemScores` rejects; the route answers 400
 *     `work_item_scores_invalid` with the package issues, before any SQL, never 500.
 *   - EXACT_HOSTS_ONLY: the configured Grafana stack host is accepted; another Grafana Cloud tenant is not.
 *   - PATCH_NULL_CLEARS: `scores: null` clears the column; the DTO then omits `scores`.
 * Side-effects: none
 * Links: src/bootstrap/work-item-scores.ts, src/app/_facades/work/items.server.ts,
 *   src/app/api/v1/work/items/_errors.ts, cogni-dao/node-template#198 (ported tests), hub work-item-scores-design
 * @internal
 */

import type { WorkItem } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";
import * as createHandler from "@/app/api/v1/work/items/route";
import { workItemScoreEvidenceHosts } from "@/bootstrap/work-item-scores";

const GRAFANA_URL = "https://cogni-ops.grafana.net/";

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
      clock: { now: vi.fn(() => new Date("2026-10-23T00:00:00Z")) },
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
    throw new Error("SQL must not run for rejected scores");
  };
  return Object.assign(refuse, {
    unsafe: refuse,
    reserve: refuse,
    begin: refuse,
    end: async () => undefined,
  }) as unknown as Sql;
}

/** The real adapter, wired exactly as the container wires it. */
function realAdapterOverStubSql(): DoltgresWorkItemAdapter {
  return new DoltgresWorkItemAdapter(stubSql(), {
    readClient: stubSql(),
    scoreEvidenceHosts: workItemScoreEvidenceHosts(GRAFANA_URL),
  });
}

/** Minimal in-memory store honouring the content-port create/get/patch surface. */
function memoryStore() {
  const rows = new Map<string, WorkItem>();
  return {
    list: vi.fn().mockResolvedValue({
      items: [],
      pageInfo: { endCursor: null, hasMore: false },
    }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    create: vi.fn(async (input: Partial<WorkItem>) => {
      const id = toWorkItemId("task.5999");
      const item = {
        id,
        type: input.type ?? "task",
        title: input.title ?? "",
        status: "needs_triage",
        node: "operator",
        actor: "either",
        assignees: [],
        externalRefs: [],
        labels: [],
        specRefs: [],
        revision: 0,
        deployVerified: false,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        ...(input.scores !== undefined && { scores: input.scores }),
      } as WorkItem;
      rows.set(id, item);
      return item;
    }),
    patch: vi.fn(
      async (input: { id: string; set: Record<string, unknown> }) => {
        const current = rows.get(input.id);
        if (!current) return null;
        const { scores, ...rest } = input.set;
        const next: Record<string, unknown> = {
          ...current,
          ...rest,
          revision: current.revision + 1,
        };
        if (scores === null) delete next.scores;
        else if (scores !== undefined) next.scores = scores;
        rows.set(input.id, next as WorkItem);
        return next as WorkItem;
      }
    ),
    delete: vi.fn(),
  };
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("work-item scores HTTP boundary (story.5111)", () => {
  beforeEach(() => {
    sqlCalls.mockReset();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    state.store = realAdapterOverStubSql();
  });

  it.each([
    ["v ≥ 4 without ev", { goal: { v: 4 } }, "evidence_required"],
    [
      "another Grafana Cloud tenant as ev",
      { goal: { v: 4, ev: "https://attacker.grafana.net/d/x" } },
      "evidence_host_not_allowed",
    ],
    [
      "http ev",
      { goal: { v: 4, ev: "http://cognidao.org/x" } },
      "evidence_not_https",
    ],
    ["v above 5", { goal: { v: 6 } }, "invalid_value"],
    ["uppercase axis id", { Goal: { v: 1 } }, "invalid_axis_id"],
    ["extra property", { goal: { v: 1, note: "x" } }, "unknown_property"],
  ])("POST create with %s is a 400 from the adapter's validator, before any SQL", async (_label, scores, code) => {
    await testApiHandler({
      appHandler: createHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          ...json({ type: "task", title: "scored", scores }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({
          error: "invalid input",
          errorCode: "work_item_scores_invalid",
        });
        expect(
          body.issues.map((issue: { code: string }) => issue.code)
        ).toContain(code);
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("PATCH with invalid scores is a 400 with the package issue path, before any SQL", async () => {
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          ...json({ expectedRevision: 3, set: { scores: { goal: { v: 5 } } } }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          errorCode: "work_item_scores_invalid",
          issues: [{ code: "evidence_required", path: ["goal", "ev"] }],
        });
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("rejects a non-object scores shape at the contract, before the store", async () => {
    await testApiHandler({
      appHandler: createHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          ...json({
            type: "task",
            title: "scored",
            scores: { goal: { v: "5" } },
          }),
        });
        expect(res.status).toBe(400);
      },
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("round-trips create → read → patch → clear through the facade", async () => {
    const store = memoryStore();
    state.store = store;
    const created = {
      goal: {
        v: 5,
        ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself",
      },
      ease: { v: 3 },
    };
    const patched = {
      goal: { v: 4, ev: "https://cogni-ops.grafana.net/d/abc" },
    };

    await testApiHandler({
      appHandler: createHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          ...json({ type: "task", title: "scored", scores: created }),
        });
        expect(res.status).toBe(201);
        expect((await res.json()).scores).toEqual(created);
      },
    });
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ scores: created }),
      expect.any(String)
    );

    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5999" },
      async test({ fetch }) {
        const read = await fetch({ method: "GET" });
        expect(read.status).toBe(200);
        expect((await read.json()).scores).toEqual(created);

        const res = await fetch({
          method: "PATCH",
          ...json({ set: { scores: patched } }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).scores).toEqual(patched);

        const cleared = await fetch({
          method: "PATCH",
          ...json({ set: { scores: null } }),
        });
        expect(cleared.status).toBe(200);
        expect(await cleared.json()).not.toHaveProperty("scores");
      },
    });
    expect(store.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({ set: { scores: null } }),
      expect.any(String)
    );
  });
});
