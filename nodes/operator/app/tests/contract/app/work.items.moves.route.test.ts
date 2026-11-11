// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.moves.route`
 * Purpose: The HTTP boundary of work-item `moves`: the create and PATCH contracts and error mapping, and the read-time verdict on a single-item read (story.0033).
 * Scope: Real routes, facade and error mapping over a stubbed Doltgres store and a stubbed goal-metric service. No database.
 * Invariants:
 *   - SERVER_OWNS_BASELINE: a baseline in the request body never reaches the store.
 *   - READ_TIME_ENRICHMENT: a single-item read, a create response and a patch response carry `{ baseline, current, moved }` per move; `unknown` names a missing reading and is never zero.
 *   - READ_IS_BOUNDED: at most one baseline lookup and one latest lookup per move; an item with no moves costs no lookup.
 *   - UNKNOWN_METRIC_IS_400: an unknown or deprecated metric id is HTTP 400 `cite_unresolved` at `set.moves` (patch) or `moves` (create); a cite failure stays at `cites`.
 *   - EACH_FAILURE_HAS_ITS_OWN_CODE: `moves_invalid` and `moves_unsupported` are 400; a baseline failure is 503 `metric_baseline_unavailable`; a resolver failure is 503 `cite_resolver_unavailable`.
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts, src/app/api/v1/work/items/_errors.ts, hub metric-foundation-design
 * @internal
 */

import {
  EntryUnresolvedError,
  MovesInvalidError,
  MovesUnsupportedError,
} from "@cogni/work-items";
import { MetricError } from "@cogni-dao/metrics/contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";
import * as collectionHandler from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  observation: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

const { patch, get, create, read, observation } = mocks;

const OBS_BASE = "11111111-1111-4111-8111-111111111111";
const OBS_B2 = "22222222-2222-4222-8222-222222222222";

const log = {
  child: vi.fn(() => log),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function container(withMetrics = true) {
  return {
    log,
    clock: { now: vi.fn(() => new Date("2026-11-10T00:00:00Z")) },
    config: { unhandledErrorPolicy: "respond_500" },
    doltgresWorkItems: { patch, get, create },
    ...(withMetrics ? { goalMetrics: { read, observation } } : {}),
  } as never;
}

const base = {
  id: "task.5001",
  type: "task",
  title: "Moves fixture",
  status: "needs_implement",
  node: "operator",
  actor: "either",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const stored = (...moves: [string, "up" | "down", string | null][]) => ({
  ...base,
  moves: moves.map(([metricId, direction, baselineObservationId]) => ({
    metricId,
    direction,
    baselineObservationId,
  })),
});
const ok = (
  id: string,
  value: number,
  observedAt = "2026-11-10T00:00:00.000Z"
) => ({ id, status: "ok", value, observedAt });

/** A parsed JSON response; the body is read by path in each assertion. */
type Reply = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads many response shapes by path
  body: Record<string, any>;
};

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function patchItem(body: unknown) {
  let out: Reply | undefined;
  await testApiHandler({
    appHandler: byIdHandler,
    params: { id: "task.5001" },
    async test({ fetch }) {
      const res = await fetch(json("PATCH", body));
      out = { status: res.status, body: await res.json() };
    },
  });
  return out as Reply;
}

async function createItem(body: unknown) {
  let out: Reply | undefined;
  await testApiHandler({
    appHandler: collectionHandler,
    async test({ fetch }) {
      const res = await fetch(json("POST", body));
      out = { status: res.status, body: await res.json() };
    },
  });
  return out as Reply;
}

async function getItem() {
  let out: Reply | undefined;
  await testApiHandler({
    appHandler: byIdHandler,
    params: { id: "task.5001" },
    async test({ fetch }) {
      const res = await fetch({ method: "GET" });
      out = { status: res.status, body: await res.json() };
    },
  });
  return out as Reply;
}

describe("work-item moves HTTP boundary (story.0033)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    log.child.mockReturnValue(log);
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    vi.mocked(getContainer).mockReturnValue(container());
  });

  describe("PATCH", () => {
    it("forwards moves and never a client baseline, and returns the readings", async () => {
      patch.mockResolvedValue(stored(["convergence-ratio", "up", OBS_BASE]));
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 0.4) });
      observation.mockResolvedValue({ observation: ok(OBS_BASE, 0.2) });
      const res = await patchItem({
        reason: "this raises the ratio",
        set: {
          moves: [
            {
              metricId: "convergence-ratio",
              direction: "up",
              baselineObservationId: "99999999-9999-4999-8999-999999999999",
              moved: "against",
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(patch.mock.calls[0]?.[0]).toEqual({
        id: "task.5001",
        reason: "this raises the ratio",
        set: { moves: [{ metricId: "convergence-ratio", direction: "up" }] },
      });
      expect(res.body.moves).toEqual([
        {
          metricId: "convergence-ratio",
          direction: "up",
          baselineObservationId: OBS_BASE,
          baseline: { value: 0.2, observedAt: "2026-11-10T00:00:00.000Z" },
          current: { value: 0.4, observedAt: "2026-11-10T00:00:00.000Z" },
          moved: "as_declared",
        },
      ]);
    });

    it("accepts [] and forwards it without a metric lookup", async () => {
      patch.mockResolvedValue({ ...base, moves: [] });
      const res = await patchItem({ reason: "docs only", set: { moves: [] } });
      expect(res.status).toBe(200);
      expect(patch.mock.calls[0]?.[0].set).toEqual({ moves: [] });
      expect(res.body.moves).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });

    it.each([
      [
        "four entries",
        [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" })),
      ],
      [
        "a repeated id",
        [
          { metricId: "m", direction: "up" },
          { metricId: "m", direction: "down" },
        ],
      ],
      ["a bad direction", [{ metricId: "m", direction: "sideways" }]],
      ["a 41-character id", [{ metricId: "x".repeat(41), direction: "up" }]],
    ])("rejects %s with 400 before the store", async (_name, moves) => {
      const res = await patchItem({ reason: "r", set: { moves } });
      expect(res.status).toBe(400);
      expect(patch).not.toHaveBeenCalled();
    });

    it("maps an unknown or deprecated metric to 400 cite_unresolved at set.moves", async () => {
      patch.mockRejectedValue(new EntryUnresolvedError(["ghost"], "moves"));
      const res = await patchItem({
        reason: "r",
        set: { moves: [{ metricId: "ghost", direction: "up" }] },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: "invalid input",
        errorCode: "cite_unresolved",
        ids: ["ghost"],
        issues: [
          {
            code: "custom",
            path: ["set", "moves"],
            message: "metric not found or deprecated: ghost",
          },
        ],
      });
    });

    it("keeps a cite failure at the cites path", async () => {
      patch.mockRejectedValue(new EntryUnresolvedError(["ghost"]));
      const res = await patchItem({
        reason: "r",
        cites: [{ id: "ghost" }],
        set: { summary: "x" },
      });
      expect(res.body.issues[0]).toMatchObject({ path: ["cites"] });
    });

    it("maps adapter-bundle copies by name, and moves_unsupported and moves_invalid to 400", async () => {
      const moves = [{ metricId: "m", direction: "up" }];
      patch.mockRejectedValue(
        Object.assign(new Error("copy"), {
          name: "EntryUnresolvedError",
          ids: ["ghost"],
          field: "moves",
        })
      );
      const unresolved = await patchItem({ reason: "r", set: { moves } });
      expect(unresolved.status).toBe(400);
      expect(unresolved.body.issues[0]).toMatchObject({
        path: ["set", "moves"],
      });

      patch.mockRejectedValue(new MovesUnsupportedError());
      const unsupported = await patchItem({ reason: "r", set: { moves } });
      expect(unsupported.status).toBe(400);
      expect(unsupported.body).toMatchObject({
        errorCode: "moves_unsupported",
      });

      patch.mockRejectedValue(
        Object.assign(new Error("bad"), {
          name: "MovesInvalidError",
          issues: ["moves must be an array"],
        })
      );
      const invalid = await patchItem({ reason: "r", set: { moves } });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({
        errorCode: "moves_invalid",
        issues: [{ path: ["set", "moves"], message: "moves must be an array" }],
      });

      patch.mockRejectedValue(new MovesInvalidError(["x"]));
      expect((await patchItem({ reason: "r", set: { moves } })).status).toBe(
        400
      );
    });

    it("maps a resolver failure and a baseline failure to their own 503 codes", async () => {
      const moves = [{ metricId: "m", direction: "up" }];
      patch.mockRejectedValue(
        Object.assign(new Error("down"), {
          name: "EntryResolverUnavailableError",
        })
      );
      const resolver = await patchItem({ reason: "r", set: { moves } });
      expect(resolver.status).toBe(503);
      expect(resolver.body).toMatchObject({
        errorCode: "cite_resolver_unavailable",
      });

      patch.mockRejectedValue(
        Object.assign(new Error("baseline down"), {
          name: "MetricBaselineUnavailableError",
        })
      );
      const baseline = await patchItem({ reason: "r", set: { moves } });
      expect(baseline.status).toBe(503);
      expect(baseline.body).toMatchObject({
        errorCode: "metric_baseline_unavailable",
      });
    });
  });

  describe("POST (create with moves)", () => {
    const filed = { type: "task", title: "Filed with a metric" };

    it("forwards moves, strips a client baseline, and returns the readings", async () => {
      create.mockResolvedValue({
        ...stored(["convergence-ratio", "up", OBS_BASE]),
        id: "task.5002",
      });
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 0.5) });
      observation.mockResolvedValue({ observation: ok(OBS_BASE, 0.25) });
      const res = await createItem({
        ...filed,
        moves: [
          {
            metricId: "convergence-ratio",
            direction: "up",
            baselineObservationId: OBS_B2,
          },
        ],
      });
      expect(res.status).toBe(201);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        ...filed,
        moves: [{ metricId: "convergence-ratio", direction: "up" }],
      });
      expect(create.mock.calls[0]?.[0].moves[0]).not.toHaveProperty(
        "baselineObservationId"
      );
      expect(res.body.moves[0]).toMatchObject({
        baselineObservationId: OBS_BASE,
        baseline: { value: 0.25 },
        current: { value: 0.5 },
        moved: "as_declared",
      });
    });

    it("accepts [] and omits moves when absent", async () => {
      create.mockResolvedValue({ ...base, moves: [] });
      expect((await createItem({ ...filed, moves: [] })).status).toBe(201);
      expect(create.mock.calls[0]?.[0].moves).toEqual([]);
      create.mockResolvedValue(base);
      expect((await createItem(filed)).status).toBe(201);
      expect(create.mock.calls[1]?.[0]).not.toHaveProperty("moves");
    });

    it.each([
      [
        "four entries",
        [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" })),
      ],
      [
        "a repeated id",
        [
          { metricId: "m", direction: "up" },
          { metricId: "m", direction: "up" },
        ],
      ],
      ["a bad direction", [{ metricId: "m", direction: "left" }]],
    ])("rejects %s with 400 before the store", async (_name, moves) => {
      expect((await createItem({ ...filed, moves })).status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });

    it("maps an unknown metric to 400 at the moves path, unsupported to 400, and a baseline failure to 503", async () => {
      const moves = [{ metricId: "ghost", direction: "up" }];
      create.mockRejectedValue(new EntryUnresolvedError(["ghost"], "moves"));
      const unknown = await createItem({ ...filed, moves });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({
        errorCode: "cite_unresolved",
        issues: [
          { path: ["moves"], message: "metric not found or deprecated: ghost" },
        ],
      });

      create.mockRejectedValue(new MovesUnsupportedError());
      const unsupported = await createItem({ ...filed, moves });
      expect(unsupported.status).toBe(400);
      expect(unsupported.body).toMatchObject({
        errorCode: "moves_unsupported",
        issues: [{ path: ["moves"] }],
      });

      create.mockRejectedValue(
        Object.assign(new Error("down"), {
          name: "MetricBaselineUnavailableError",
        })
      );
      const baseline = await createItem({ ...filed, moves });
      expect(baseline.status).toBe(503);
      expect(baseline.body).toMatchObject({
        errorCode: "metric_baseline_unavailable",
      });
    });
  });

  describe("GET (read-time enrichment)", () => {
    const readings = (baseline: number | null, current: number | null) => {
      observation.mockImplementation(async () => ({
        observation:
          baseline === null
            ? null
            : ok(OBS_BASE, baseline, "2026-11-01T00:00:00.000Z"),
      }));
      read.mockImplementation(async () => ({
        lastGood:
          current === null
            ? null
            : ok(OBS_B2, current, "2026-11-10T00:00:00.000Z"),
      }));
    };
    const moveOf = async () => (await getItem()).body.moves[0];

    it.each([
      ["up", 1, 2, "as_declared"],
      ["up", 2, 1, "against"],
      ["down", 2, 1, "as_declared"],
      ["down", 1, 2, "against"],
      ["up", 3, 3, "flat"],
    ] as const)("%s from %s to %s is %s", async (direction, from, to, expected) => {
      get.mockResolvedValue(stored(["m-1", direction, OBS_BASE]));
      readings(from, to);
      expect(await moveOf()).toMatchObject({
        metricId: "m-1",
        direction,
        baselineObservationId: OBS_BASE,
        baseline: { value: from, observedAt: "2026-11-01T00:00:00.000Z" },
        current: { value: to, observedAt: "2026-11-10T00:00:00.000Z" },
        moved: expected,
      });
    });

    it("a null baseline reads unknown (no_baseline) with no lookup, never zero", async () => {
      get.mockResolvedValue(stored(["m-1", "up", null]));
      readings(1, 5);
      expect(await moveOf()).toMatchObject({
        baselineObservationId: null,
        baseline: null,
        current: null,
        moved: "unknown",
        unknownReason: "no_baseline",
      });
      expect(observation).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it("a pinned observation that cannot be read, or no current reading, reads unknown", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      readings(null, 5);
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "baseline_unreadable",
      });
      readings(1, null);
      expect(await moveOf()).toMatchObject({
        baseline: { value: 1 },
        current: null,
        moved: "unknown",
        unknownReason: "no_current",
      });
    });

    it("a deprecated metric reads unknown (metric_deprecated), not a failure", async () => {
      get.mockResolvedValue(
        stored(["old-metric", "up", OBS_BASE], ["live", "up", OBS_BASE])
      );
      observation.mockImplementation(async (id: string) => {
        if (id === "old-metric") throw new MetricError("metric_not_found", 404);
        return { observation: ok(OBS_BASE, 1) };
      });
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 2) });
      const res = await getItem();
      expect(res.status).toBe(200);
      expect(res.body.moves[0]).toMatchObject({
        metricId: "old-metric",
        baselineObservationId: OBS_BASE,
        moved: "unknown",
        unknownReason: "metric_deprecated",
      });
      expect(res.body.moves[1]).toMatchObject({ moved: "as_declared" });
    });

    it("a missing observation is not a deprecated metric", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      observation.mockRejectedValue(
        new MetricError("observation_not_found", 404)
      );
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 2) });
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "baseline_unreadable",
      });
    });

    it("a failing metrics service reads unknown and never fails the item read", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      observation.mockRejectedValue(new Error("db down"));
      const res = await getItem();
      expect(res.status).toBe(200);
      expect(res.body.moves[0]).toMatchObject({ moved: "unknown" });
    });

    it("a node with no metrics service reads every move unknown (metrics_unavailable)", async () => {
      vi.mocked(getContainer).mockReturnValue(container(false));
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "metrics_unavailable",
      });
    });

    it("looks up at most one baseline and one latest reading per move, three moves at most", async () => {
      get.mockResolvedValue(
        stored(
          ["m-1", "up", OBS_BASE],
          ["m-2", "down", OBS_BASE],
          ["m-3", "up", OBS_BASE]
        )
      );
      readings(1, 2);
      const moves = (await getItem()).body.moves;
      expect(moves.map((m: { moved: string }) => m.moved)).toEqual([
        "as_declared",
        "against",
        "as_declared",
      ]);
      expect(observation).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenCalledTimes(3);
    });

    it("an item that declares no moves costs no lookup, and [] stays []", async () => {
      get.mockResolvedValue(base);
      expect((await getItem()).body).not.toHaveProperty("moves");
      get.mockResolvedValue({ ...base, moves: [] });
      expect((await getItem()).body.moves).toEqual([]);
      expect(observation).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it("a failed observation never counts as a reading", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      observation.mockResolvedValue({
        observation: {
          id: OBS_BASE,
          status: "error",
          value: 1,
          observedAt: "x",
        },
      });
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 2) });
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "baseline_unreadable",
      });
    });
  });
});
