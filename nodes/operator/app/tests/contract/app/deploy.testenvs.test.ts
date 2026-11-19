// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.testenvs`
 * Purpose: Contract tests for `/api/v2/test-envs` (story.5159): the v2 routes run the SAME authorization gate as
 *   `POST /api/v1/deploy/workloads` on candidate-a (`node.flight` OR `node.manage_envs`, then the served-env and
 *   deploy-verb refusals), read and write nothing on a denial, hand the one release writer a `testEnv` input whose
 *   cap is the node constant (5), and answer the v2 shapes.
 * Invariants:
 *   - SAME_GATE_AS_V1: the authz actions checked are exactly `authzActionsForEnv("candidate-a")`, in order.
 *   - AUTHZ_BEFORE_READ_OR_WRITE: a denial calls neither the release writer nor `requestStop`.
 *   - TEST_ENVS_ONLY: DELETE and GET refuse any id that is not a te key, so they can never touch `app`.
 * Side-effects: none
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authzActionsForEnv } from "@/app/api/v1/deploy/workloads/_lib/authz";
import {
  TestEnvCreatedSchema,
  TestEnvReadSchema,
} from "@/contracts/test-envs.v2.contract";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const SHA = "a".repeat(40);
const KEY = "teqwkzmx";
const REL = "00000000-0000-4000-8000-000000000001";
const MIN = 60_000;

const store = vi.hoisted(() => ({
  listDesired: vi.fn(),
  getRelease: vi.fn(),
  attemptsFor: vi.fn(),
  requestStop: vi.fn(),
}));
const record = vi.hoisted(() => vi.fn());
const keys = vi.hoisted(() => ({ next: [] as string[] }));
const authz = vi.hoisted(() => ({ check: vi.fn() }));
const dbState = vi.hoisted(() => ({ call: 0 }));
const envState = vi.hoisted(() => ({
  DEPLOY_ENVIRONMENT: "candidate-a" as string | undefined,
  NODE_DEPLOY_ENVS: undefined as string | undefined,
  NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
  NODE_DEPLOY_WORKLOAD_ZONE: "cognidao.org" as string | undefined,
  FLEET_CONTROL_ENV: "production",
}));
const catalog = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
}));
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bootstrap/capabilities/node-catalog", () => ({
  createNodeCatalog: () => ({
    entryFor: async () => ({ slug: "operator", row: catalog.row }),
  }),
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => store,
}));
vi.mock("@/app/_facades/deploy/record-node-release.server", () => ({
  recordNodeRelease: (...args: unknown[]) => record(...args),
}));
vi.mock("@/features/node-deploy/test-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/node-deploy/test-env")>()),
  newTestEnvKey: () => keys.next.shift() ?? "tezzzzzz",
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-11-02T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization: { check: authz.check },
  }),
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const first = dbState.call === 0;
            dbState.call += 1;
            return first
              ? [{ id: NODE_ID, slug: "operator" }]
              : [{ id: "billing-1" }];
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: {
      traceId: string;
      span: { setAttribute: () => void };
    }) => Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => envState }));
vi.mock("@/shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/config")>();
  return { ...actual, getNodeId: () => "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d" };
});
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));
vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "deploy.testenvs",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as idHandler from "@/app/api/v2/test-envs/[id]/route";
import * as createHandler from "@/app/api/v2/test-envs/route";

const allow = { decision: "allow", code: "authz_allowed" };
const deny = { decision: "deny", code: "authz_denied" };

async function call(
  handler: object,
  url: string,
  init: { method: string; body?: unknown },
  params?: Record<string, string>
) {
  let res!: Response;
  await testApiHandler({
    appHandler: handler,
    url,
    params,
    async test({ fetch }) {
      res = await fetch({
        method: init.method,
        ...(init.body !== undefined
          ? {
              body: JSON.stringify(init.body),
              headers: { "content-type": "application/json" },
            }
          : {}),
      });
    },
  });
  return res;
}
const post = (body: unknown) =>
  call(createHandler, "/api/v2/test-envs", { method: "POST", body });
const get = (id: string) =>
  call(idHandler, `/api/v2/test-envs/${id}`, { method: "GET" }, { id });
const del = (id: string) =>
  call(idHandler, `/api/v2/test-envs/${id}`, { method: "DELETE" }, { id });

const desired = (workload: string, state = "running") => ({
  nodeId: NODE_ID,
  env: "candidate-a",
  workload,
  state,
  releaseId: REL,
  updatedAt: new Date(Date.now() - 10 * MIN),
});
const GOOD = { nodeId: NODE_ID, sourceSha: SHA };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.call = 0;
  keys.next = [];
  catalog.row = {};
  envState.DEPLOY_ENVIRONMENT = "candidate-a";
  authz.check.mockResolvedValue(allow);
  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
  store.listDesired.mockResolvedValue([desired("app")]);
  store.getRelease.mockResolvedValue({
    id: REL,
    sourceSha: SHA,
    createdAt: new Date(Date.now() - 10 * MIN),
    spec: {
      name: KEY,
      kind: "app",
      env: { COGNI_TEST_ENV_LABEL: "pr-7" },
      expose: { http: { host: `operator-${KEY}-test.cognidao.org` } },
    },
  });
  store.attemptsFor.mockResolvedValue([]);
  store.requestStop.mockResolvedValue({ ok: true });
  record.mockResolvedValue({
    ok: true,
    releaseId: REL,
    desiredState: "running",
    host: `operator-${KEY}-test.cognidao.org`,
  });
});

describe("POST /api/v2/test-envs", () => {
  it("401 when unauthenticated; nothing is recorded", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await post(GOOD)).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { nodeId: NODE_ID },
    { nodeId: NODE_ID, sourceSha: "main" },
    { nodeId: NODE_ID, sourceSha: SHA, env: "production" },
    { nodeId: NODE_ID, sourceSha: SHA, label: "Bad Label" },
    { nodeId: NODE_ID, sourceSha: SHA, workload: "app" },
  ])("400 for the body %j, before the gate", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(authz.check).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("runs the SAME authz actions as v1 on candidate-a (node.flight OR node.manage_envs), in order", async () => {
    expect(authzActionsForEnv("candidate-a")).toEqual([
      "node.flight",
      "node.manage_envs",
    ]);
    authz.check.mockResolvedValueOnce(deny).mockResolvedValueOnce(allow);
    const res = await post(GOOD);
    expect(res.status).toBe(202);
    expect(authz.check.mock.calls.map((c) => c[0].action)).toEqual(
      authzActionsForEnv("candidate-a")
    );
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({ resource: `node:${NODE_ID}` })
    );
  });

  it("403 when both candidate-a actions are denied; the writer is never called", async () => {
    authz.check.mockResolvedValue(deny);
    expect((await post(GOOD)).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("503 when authz is unavailable (fail closed)", async () => {
    authz.check.mockResolvedValue({
      decision: "deny",
      code: "authz_unavailable",
    });
    expect((await post(GOOD)).status).toBe(503);
    expect(record).not.toHaveBeenCalled();
  });

  it("409 env_not_served when this operator does not serve candidate-a", async () => {
    envState.DEPLOY_ENVIRONMENT = "production";
    const res = await post(GOOD);
    expect(res.status).toBe(409);
    expect(record).not.toHaveBeenCalled();
  });

  it("202 {testEnvId, host, state}; hands the writer the key, label and the node cap (5)", async () => {
    const res = await post({ ...GOOD, label: "pr-7" });
    expect(res.status).toBe(202);
    const body = TestEnvCreatedSchema.parse(await res.json());
    expect(body).toEqual({
      testEnvId: "tezzzzzz",
      host: `operator-${KEY}-test.cognidao.org`,
      state: "requested",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      env: "candidate-a",
      workload: "tezzzzzz",
      sourceSha: SHA,
      createdBy: `user:${TEST_SESSION_USER_1.id}`,
      testEnv: { key: "tezzzzzz", label: "pr-7", cap: 5 },
    });
  });

  it("draws a new key when the first is taken by any node on the env", async () => {
    keys.next = ["teaaaaaa", "tebbbbbb"];
    store.listDesired.mockResolvedValue([
      {
        ...desired("teaaaaaa"),
        nodeId: "00000000-0000-4000-8000-000000000009",
      },
    ]);
    await post(GOOD);
    expect(record.mock.calls[0]?.[0].testEnv.key).toBe("tebbbbbb");
  });

  it("passes the writer's 409 test_env_cap through as is", async () => {
    record.mockResolvedValue({
      ok: false,
      status: 409,
      body: { error: "test_env_cap", cap: 2, running: 2 },
    });
    const res = await post(GOOD);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "test_env_cap",
      cap: 2,
      running: 2,
    });
  });
});

describe("GET /api/v2/test-envs/{id}", () => {
  it("400 for an id that is not a te key, so `app` can never be read through v2", async () => {
    expect((await get("app")).status).toBe(400);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("404 for an unknown id", async () => {
    expect((await get("tenotthr")).status).toBe(404);
    expect(authz.check).not.toHaveBeenCalled();
  });

  it("403 for a known id the caller may not touch; nothing else is read", async () => {
    store.listDesired.mockResolvedValue([desired(KEY)]);
    authz.check.mockResolvedValue(deny);
    expect((await get(KEY)).status).toBe(403);
    expect(store.getRelease).not.toHaveBeenCalled();
  });

  it("answers ready with requestedAt, readyAt and readyMs, schema-valid", async () => {
    store.listDesired.mockResolvedValue([desired(KEY)]);
    const requested = new Date(Date.now() - 10 * MIN);
    store.getRelease.mockResolvedValue({
      id: REL,
      sourceSha: SHA,
      createdAt: requested,
      spec: {
        name: KEY,
        kind: "app",
        env: { COGNI_TEST_ENV_LABEL: "pr-7" },
        expose: { http: { host: `operator-${KEY}-test.cognidao.org` } },
      },
    });
    store.attemptsFor.mockResolvedValue([
      {
        id: "a1",
        releaseId: REL,
        attempt: 1,
        cogniKey: "k",
        endpoints: [],
        phase: "active",
        createdAt: requested,
        activatedAt: new Date(requested.getTime() + 6 * MIN),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const res = await get(KEY);
    expect(res.status).toBe(200);
    const body = TestEnvReadSchema.parse(await res.json());
    expect(body).toMatchObject({
      testEnvId: KEY,
      nodeId: NODE_ID,
      sourceSha: SHA,
      host: `operator-${KEY}-test.cognidao.org`,
      label: "pr-7",
      state: "ready",
      readyMs: 6 * MIN,
    });
    expect(body.requestedAt).toBe(requested.toISOString());
    expect(body.readyAt).toBe(
      new Date(requested.getTime() + 6 * MIN).toISOString()
    );
    expect(body.expiresAt).not.toBeNull();
  });
});

describe("DELETE /api/v2/test-envs/{id}", () => {
  it("400 for `app` or any non-te id: a v2 close can never stop a real lane", async () => {
    for (const id of ["app", "canary", "te-abc"])
      expect((await del(id)).status).toBe(400);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("404 for an unknown id", async () => {
    expect((await del("tenotthr")).status).toBe(404);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("403 on a denial; requestStop is not called", async () => {
    store.listDesired.mockResolvedValue([desired(KEY)]);
    authz.check.mockResolvedValue(deny);
    expect((await del(KEY)).status).toBe(403);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("202: records the stop by the caller through the one writer and reports closing while a lease is open", async () => {
    store.listDesired.mockResolvedValue([desired(KEY)]);
    store.attemptsFor.mockResolvedValue([{ phase: "active" }]);
    const res = await del(KEY);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ testEnvId: KEY, state: "closing" });
    expect(store.requestStop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workload: KEY }),
      { by: `user:${TEST_SESSION_USER_1.id}`, releaseId: REL }
    );
  });

  it("is idempotent: an already stopped env is answered without another stop", async () => {
    store.listDesired.mockResolvedValue([desired(KEY, "stopped")]);
    store.attemptsFor.mockResolvedValue([{ phase: "retired" }]);
    const res = await del(KEY);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ testEnvId: KEY, state: "closed" });
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("409 when the release changed under the caller", async () => {
    store.listDesired.mockResolvedValue([desired(KEY)]);
    store.requestStop.mockResolvedValue({
      ok: false,
      reason: "release_changed",
    });
    expect((await del(KEY)).status).toBe(409);
  });
});
