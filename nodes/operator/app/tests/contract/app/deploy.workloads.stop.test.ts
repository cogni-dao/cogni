// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.workloads.stop`
 * Purpose: Contract tests for DELETE /api/v1/deploy/workloads (task.5491): the same per-env authz as POST,
 *   the 409 refusals for retained state, and ONE store writer call that never touches a lease.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; a denial reads no row and writes nothing.
 *   - STOP_IS_INTENT_ONLY: 200 means `requestStop` was called once; this route never pays or touches DNS.
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
  requestStop: vi.fn(),
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

import * as appHandler from "@/app/api/v1/deploy/workloads/route";
import { DeployWorkloadStoppedSchema } from "@/contracts/deploy.workloads.v1.contract";

async function del(body: unknown): Promise<Response> {
  let res!: Response;
  await testApiHandler({
    appHandler,
    url: "/api/v1/deploy/workloads",
    async test({ fetch }) {
      res = await fetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });
  return res;
}

const valid = { nodeId: NODE_ID, env: "production", workload: "canary" };
const STATE = { workload: "canary-db", state: "running", releaseId: "rel-db" };
const attempt = (phase: string, externalName?: string) => ({
  phase,
  externalName,
});

describe("DELETE /api/v1/deploy/workloads", () => {
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
    store.getRelease.mockResolvedValue({ spec: { kind: "app", bindings: [] } });
    store.attemptsFor.mockResolvedValue([attempt("active", "1002")]);
    store.listDesired.mockResolvedValue([]);
    store.requestStop.mockResolvedValue({ ok: true });
  });

  it("401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await del(valid)).status).toBe(401);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing workload", { nodeId: NODE_ID, env: "production" }],
    ["an unknown env", { ...valid, env: "dev" }],
    ["an unknown key", { ...valid, sourceSha: "a".repeat(40) }],
    ["a bad workload name", { ...valid, workload: "Canary_DB" }],
    ["dseq without the flag", { ...valid, dseq: "1001" }],
    ["the flag without a dseq", { ...valid, destroyRetainedData: true }],
    [
      "a flag that is not true",
      { ...valid, destroyRetainedData: false, dseq: "1" },
    ],
    [
      "a dseq that is not a number",
      { ...valid, destroyRetainedData: true, dseq: "abc" },
    ],
  ])("400 for %s", async (_n, body) => {
    expect((await del(body)).status).toBe(400);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("400 for a body that is not JSON", async () => {
    let res!: Response;
    await testApiHandler({
      appHandler,
      url: "/api/v1/deploy/workloads",
      async test({ fetch }) {
        res = await fetch({ method: "DELETE", body: "nope" });
      },
    });
    expect(res.status).toBe(400);
  });

  it("404 for an unknown node", async () => {
    dbState.node = null;
    expect((await del(valid)).status).toBe(404);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("403 and NOTHING read or written when authz denies (production)", async () => {
    authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
    const res = await del(valid);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(store.getDesired).not.toHaveBeenCalled();
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("503 when authorization is unavailable (fail closed)", async () => {
    authz.present = false;
    expect((await del(valid)).status).toBe(503);
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("production checks node.promote_production, the same capability as POST", async () => {
    await del(valid);
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "node.promote_production",
        resource: `node:${NODE_ID}`,
      })
    );
  });

  it("409 env_not_served for an env other than DEPLOY_ENVIRONMENT; nothing is read or written", async () => {
    const res = await del({ ...valid, env: "preview" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "env_not_served",
      served: ["production"],
    });
    expect(store.getDesired).not.toHaveBeenCalled();
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("404 workload_not_deployed when the workload has no desired row", async () => {
    store.getDesired.mockResolvedValue(undefined);
    const res = await del(valid);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workload_not_deployed" });
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("200 stops an app: ONE writer call with the caller, the release read and no destroy", async () => {
    const res = await del(valid);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(DeployWorkloadStoppedSchema.parse(body)).toEqual({
      nodeId: NODE_ID,
      env: "production",
      workload: "canary",
      desiredState: "stopped",
      stop: "requested",
    });
    expect(store.requestStop).toHaveBeenCalledTimes(1);
    expect(store.requestStop).toHaveBeenCalledWith(
      { nodeId: NODE_ID, env: "production", workload: "canary" },
      {
        by: `user:${TEST_SESSION_USER_1.id}`,
        releaseId: "rel-1",
        destroyDseq: undefined,
      }
    );
    expect(store.recordRelease).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "feature.node_workload_destroy.requested"
    );
  });

  it("200 on a repeat: stopping a stopped app is the same call", async () => {
    store.getDesired.mockResolvedValue({
      state: "stopped",
      releaseId: "rel-1",
    });
    expect((await del(valid)).status).toBe(200);
    expect(store.requestStop).toHaveBeenCalledTimes(1);
  });

  it("409 workload_not_retained for the destroy fields on an app", async () => {
    const res = await del({
      ...valid,
      destroyRetainedData: true,
      dseq: "1002",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "workload_not_retained" });
    expect(store.requestStop).not.toHaveBeenCalled();
  });

  it("409 release_changed when a release lands between the read and the write", async () => {
    store.requestStop.mockResolvedValue({
      ok: false,
      reason: "release_changed",
    });
    const res = await del(valid);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "release_changed" });
  });

  describe("a state workload", () => {
    const state = { workload: "canary-db" };
    const body = { ...valid, workload: "canary-db" };
    beforeEach(() => {
      store.getDesired.mockResolvedValue(STATE);
      store.getRelease.mockResolvedValue({
        spec: { kind: "state", bindings: [] },
      });
      store.attemptsFor.mockResolvedValue([attempt("active", "1001")]);
    });

    it("409 retained_state_requires_destroy for a plain stop with an open lease", async () => {
      const res = await del(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "retained_state_requires_destroy",
      });
      expect(store.requestStop).not.toHaveBeenCalled();
    });

    it("409 dseq_mismatch when the dseq is not an open lease", async () => {
      const res = await del({
        ...body,
        destroyRetainedData: true,
        dseq: "999",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "dseq_mismatch" });
      expect(store.requestStop).not.toHaveBeenCalled();
    });

    it("409 state_create_in_flight while a create has no lease id", async () => {
      store.attemptsFor.mockResolvedValue([attempt("planned")]);
      const res = await del(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "state_create_in_flight" });
    });

    it("409 state_in_use names the running consumers", async () => {
      store.listDesired.mockResolvedValue([
        {
          nodeId: NODE_ID,
          workload: "canary",
          state: "running",
          releaseId: "rel-app",
        },
        {
          nodeId: NODE_ID,
          workload: "old",
          state: "stopped",
          releaseId: "rel-old",
        },
        {
          nodeId: "other-node",
          workload: "x",
          state: "running",
          releaseId: "rel-x",
        },
      ]);
      store.getRelease.mockImplementation(async (id: string) => ({
        spec:
          id === "rel-app"
            ? {
                kind: "app",
                bindings: [{ env: "DATABASE_URL", workload: "canary-db" }],
              }
            : { kind: "state", bindings: [] },
      }));
      const res = await del({
        ...body,
        destroyRetainedData: true,
        dseq: "1001",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "state_in_use",
        consumers: ["canary"],
      });
      expect(store.requestStop).not.toHaveBeenCalled();
    });

    it("200 destroys: the writer gets the dseq and the audit event names the actor", async () => {
      const res = await del({
        ...body,
        destroyRetainedData: true,
        dseq: "1001",
      });
      expect(res.status).toBe(200);
      expect(store.requestStop).toHaveBeenCalledWith(
        { nodeId: NODE_ID, env: "production", workload: state.workload },
        {
          by: `user:${TEST_SESSION_USER_1.id}`,
          releaseId: "rel-db",
          destroyDseq: "1001",
        }
      );
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "feature.node_workload_destroy.requested",
          dseq: "1001",
          actorId: `user:${TEST_SESSION_USER_1.id}`,
        }),
        "feature.node_workload_destroy.requested"
      );
    });

    it("200 plain stop of a state workload that holds no open lease", async () => {
      store.attemptsFor.mockResolvedValue([attempt("retired", "1001")]);
      expect((await del(body)).status).toBe(200);
      expect(store.requestStop).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ destroyDseq: undefined })
      );
    });
  });
});
