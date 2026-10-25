// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/schedules/readback`
 * Purpose: Verify scheduling HTTP bindings against the installed release artifact.
 * Scope: Exercises authentication and metadata boundaries; does not access a real database.
 * Invariants: Package entrypoints remain real imports; external I/O is mocked.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */
import { PostgresScheduleRunReader } from "@cogni/scheduling/adapters/postgres";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as detail from "@/app/api/v1/schedules/[scheduleId]/route";
import * as history from "@/app/api/v1/schedules/[scheduleId]/runs/route";

const mocks = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { ...log, child: () => log },
    getSessionUser: vi.fn(),
    getSchedule: vi.fn(),
    listRuns: vi.fn(),
  };
});
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: mocks.getSessionUser,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mocks.log,
    clock: { now: () => new Date("2026-10-25T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    scheduleManager: { getSchedule: mocks.getSchedule },
    scheduleRunReader: { listRuns: mocks.listRuns },
  }),
}));

const scheduleId = "00000000-0000-4000-a000-000000000010";
const first = "00000000-0000-4000-a000-000000000011";
const second = "00000000-0000-4000-a000-000000000012";
const date = new Date("2026-10-25T00:00:00Z");
function schedule(ownerUserId = TEST_SESSION_USER_1.id) {
  return {
    id: scheduleId,
    ownerUserId,
    graphId: "langgraph:brain",
    input: {},
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: false,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: date,
    updatedAt: date,
  };
}
function run(id: string) {
  return {
    id,
    runId: id,
    stateKey: null,
    status: "success",
    scheduledFor: date.toISOString(),
    startedAt: date.toISOString(),
    completedAt: date.toISOString(),
    privatePayload: "must not escape",
  };
}

describe("shared scheduling HTTP bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mocks.getSchedule.mockResolvedValue(schedule());
    mocks.listRuns.mockResolvedValue([]);
  });

  it("serializes owned detail and disables response caching", async () => {
    await testApiHandler({
      appHandler: detail,
      params: { scheduleId },
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store, private");
        expect(await response.json()).toMatchObject({
          id: scheduleId,
          enabled: false,
          createdAt: date.toISOString(),
        });
      },
    });
  });

  it.each([
    null,
    schedule("00000000-0000-4000-a000-000000000099"),
  ])("hides absent or foreign schedules before reading runs", async (value) => {
    mocks.getSchedule.mockResolvedValue(value);
    await testApiHandler({
      appHandler: history,
      params: { scheduleId },
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(404);
        expect(mocks.listRuns).not.toHaveBeenCalled();
      },
    });
  });

  it("passes authenticated identity and returns only bounded public metadata", async () => {
    mocks.listRuns.mockResolvedValue([run(first), run(second)]);
    await testApiHandler({
      appHandler: history,
      params: { scheduleId },
      url: `/api/v1/schedules/${scheduleId}/runs?limit=1`,
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.nextCursor).toBe(first);
        expect(body.runs).toHaveLength(1);
        expect(body.runs[0].stateKey).toBeNull();
        expect(body.runs[0]).not.toHaveProperty("privatePayload");
        expect(mocks.listRuns).toHaveBeenCalledWith(
          TEST_SESSION_USER_1.id,
          scheduleId,
          { limit: 1 }
        );
      },
    });
  });

  it("maps the installed postgres adapter cursor error to HTTP400", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const sql = {
      begin: async (work: (tx: typeof query) => Promise<unknown>) =>
        work(query),
    } as unknown as Sql;
    const reader = new PostgresScheduleRunReader(sql);
    mocks.listRuns.mockImplementation((caller, id, options) =>
      reader.listRuns(caller, id, options)
    );
    await testApiHandler({
      appHandler: history,
      params: { scheduleId },
      url: `/api/v1/schedules/${scheduleId}/runs?cursor=${first}`,
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(400);
      },
    });
  });

  it("rejects out-of-bounds limits before reading schedules", async () => {
    await testApiHandler({
      appHandler: history,
      params: { scheduleId },
      url: `/api/v1/schedules/${scheduleId}/runs?limit=51`,
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(400);
        expect(mocks.getSchedule).not.toHaveBeenCalled();
      },
    });
  });

  it("rejects unauthenticated reads before accessing owned data", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    await testApiHandler({
      appHandler: history,
      params: { scheduleId },
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(401);
        expect(mocks.getSchedule).not.toHaveBeenCalled();
      },
    });
  });
});
