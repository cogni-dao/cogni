// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.workloads.game-day`
 * Purpose: Contract tests for POST/GET /api/v1/deploy/workloads (task.5400): per-env authz, the
 *   declaration read AT the sha through the GitHub App seam, intent-only writes, state create-once.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; candidate-a/preview ->
 *     `node.manage_envs`; a denial reads nothing from GitHub and writes nothing.
 *   - INTENT_ONLY: 200 means a release was recorded; this route never pays or touches DNS.
 * Side-effects: none
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";

const plane = vi.hoisted(() => ({ fetchFileText: vi.fn() }));
const store = vi.hoisted(() => ({
  recordRelease: vi.fn(),
  getDesired: vi.fn(),
  listDesired: vi.fn(),
  attemptsFor: vi.fn(),
  getRelease: vi.fn(),
  requestGameDay: vi.fn(),
}));
const authz = vi.hoisted(() => ({ check: vi.fn(), present: true }));
const dbState = vi.hoisted(() => ({
  node: null as { id: string; slug: string } | null,
  billing: null as { id: string } | null,
  call: 0,
}));
const envState = vi.hoisted(() => ({
  NODE_SUBMODULE_PARENT_OWNER: "test-owner" as string | undefined,
  NODE_SUBMODULE_PARENT_REPO: "test-repo" as string | undefined,
  DEPLOY_ENVIRONMENT: "production" as string | undefined,
  NODE_DEPLOY_WORKLOAD_ZONE: "cognidao.org",
}));
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          const first = dbState.call === 0;
          dbState.call += 1;
          if (first) return dbState.node ? [dbState.node] : [];
          return dbState.billing ? [dbState.billing] : [];
        },
      }),
    }),
  }),
};

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => plane,
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => store,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-11-02T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization: authz.present ? { check: authz.check } : undefined,
  }),
  resolveServiceDb: () => mockDb,
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
// The lane refusal (`_lib/lane`) compares the target with the operator's own node id; NODE_ID is the operator.
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
      routeId: "deploy.workloads",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/deploy/workloads/game-day/route";

async function post(body: unknown): Promise<Response> {
  let res!: Response;
  await testApiHandler({
    appHandler,
    url: "/api/v1/deploy/workloads/game-day",
    async test({ fetch }) {
      res = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });
  return res;
}

const valid = { nodeId: NODE_ID, env: "production", workload: "canary" };

describe("POST /api/v1/deploy/workloads/game-day", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: NODE_ID, slug: "operator" };
    dbState.billing = { id: "billing-1" };
    dbState.call = 0;
    authz.present = true;
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    envState.DEPLOY_ENVIRONMENT = "production";
    store.getDesired.mockResolvedValue({
      state: "running",
      releaseId: "rel-1",
    });
    store.getRelease.mockResolvedValue({ spec: { kind: "app" } });
    store.requestGameDay.mockResolvedValue(true);
  });

  it("401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await post(valid)).status).toBe(401);
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing workload", { nodeId: NODE_ID, env: "production" }],
    ["an unknown env", { ...valid, env: "dev" }],
    ["an unknown key", { ...valid, sourceSha: "a".repeat(40) }],
    ["a bad workload name", { ...valid, workload: "Canary_DB" }],
  ])("400 for %s", async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("404 for an unknown node", async () => {
    dbState.node = null;
    expect((await post(valid)).status).toBe(404);
  });

  it("403 and NO flag when authz denies (production)", async () => {
    authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(store.getDesired).not.toHaveBeenCalled();
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("503 when authorization is unavailable (fail closed)", async () => {
    authz.present = false;
    expect((await post(valid)).status).toBe(503);
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("per-env authz: production->promote_production, preview->manage_envs, candidate-a->flight OR manage_envs (bug.5574)", async () => {
    await post(valid); // DEPLOY_ENVIRONMENT=production
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "node.promote_production",
        resource: `node:${NODE_ID}`,
      })
    );

    const actionsFor = async (env: string): Promise<string[]> => {
      dbState.call = 0;
      envState.DEPLOY_ENVIRONMENT = env;
      authz.check.mockClear();
      await post({ ...valid, env });
      return authz.check.mock.calls.map((c) => c[0].action);
    };

    // preview: a single check on node.manage_envs.
    expect(await actionsFor("preview")).toEqual(["node.manage_envs"]);

    // candidate-a, developer allowed: short-circuits on node.flight, never reaches manage_envs.
    expect(await actionsFor("candidate-a")).toEqual(["node.flight"]);

    // candidate-a, env_manager only: node.flight denied falls through to node.manage_envs (additive).
    authz.check.mockImplementation(async ({ action }) => ({
      decision: action === "node.manage_envs" ? "allow" : "deny",
      code: action === "node.manage_envs" ? "authz_allowed" : "authz_denied",
    }));
    expect(await actionsFor("candidate-a")).toEqual([
      "node.flight",
      "node.manage_envs",
    ]);
  });

  it("409 env_not_served for an env other than DEPLOY_ENVIRONMENT; nothing is read or written", async () => {
    const res = await post({ ...valid, env: "preview" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "env_not_served",
      served: ["production"],
    });
    expect(store.getDesired).not.toHaveBeenCalled();
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("409 state_workload_protected for a state workload; no flag is written", async () => {
    store.getRelease.mockResolvedValue({ spec: { kind: "state" } });
    const res = await post({ ...valid, workload: "canary-db" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "state_workload_protected" });
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("404 workload_not_deployed when the workload has no desired row", async () => {
    store.getDesired.mockResolvedValue(undefined);
    const res = await post(valid);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workload_not_deployed" });
    expect(store.requestGameDay).not.toHaveBeenCalled();
  });

  it("200 records ONE intent flag for the key and touches nothing else (no release, no lease)", async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodeId: NODE_ID,
      env: "production",
      workload: "canary",
      gameDay: "requested",
    });
    expect(store.requestGameDay).toHaveBeenCalledTimes(1);
    expect(store.requestGameDay).toHaveBeenCalledWith({
      nodeId: NODE_ID,
      env: "production",
      workload: "canary",
    });
    expect(store.recordRelease).not.toHaveBeenCalled();
    expect(plane.fetchFileText).not.toHaveBeenCalled();
  });
});
