// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.instances`
 * Purpose: Contract tests for GET /api/v1/deploy/instances (story.5159 step 1): the instance directory uses
 *   the deploy reads' REAL authz gate and lane refusals, reads nothing on a denial, lists only running and
 *   proven instances of the asked node, and satisfies `DeployInstancesReadSchema`.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: a denial, an unauthenticated call and an unserved env read no desired row.
 *   - NO_ENTRY_MEANS_CLOSED: a stopped or unproven workload is absent from the directory.
 *   - READ_ONLY: the route calls only the store's reads.
 * Side-effects: none
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeployInstancesReadSchema } from "@/contracts/deploy.instances.v1.contract";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const OTHER_NODE = "00000000-0000-4000-8000-000000000009";
const R = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const store = vi.hoisted(() => ({
  listDesired: vi.fn(),
  attemptsFor: vi.fn(),
  getRelease: vi.fn(),
}));
const authz = vi.hoisted(() => ({ check: vi.fn(), present: true }));
const dbState = vi.hoisted(() => ({
  node: null as { id: string; slug: string } | null,
  billing: null as { id: string } | null,
  call: 0,
}));
const envState = vi.hoisted(() => ({
  DEPLOY_ENVIRONMENT: "production" as string | undefined,
  NODE_DEPLOY_ENVS: undefined as string | undefined,
  NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
  NODE_DEPLOY_WORKLOAD_ZONE: "cognidao.org" as string | undefined,
  FLEET_CONTROL_ENV: "production",
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
    entryFor: async () => ({
      slug: "operator",
      row: { compute_api: { production: "node-deploy" } },
    }),
  }),
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
  resolveServiceDb: () => ({
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
      routeId: "deploy.instances.list",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as instancesHandler from "@/app/api/v1/deploy/instances/route";

async function getInstances(query: string) {
  let res!: Response;
  await testApiHandler({
    appHandler: instancesHandler,
    url: `/api/v1/deploy/instances${query}`,
    async test({ fetch }) {
      res = await fetch({ method: "GET" });
    },
  });
  return res;
}

const QUERY = `?nodeId=${NODE_ID}&env=production`;
const CANARY_HOST = "node-deploy-canary.cognidao.org";
const desired = (workload: string, releaseId: string, state = "running") => ({
  nodeId: NODE_ID,
  env: "production",
  workload,
  state,
  releaseId,
  updatedAt: new Date(0),
});
const attempt = (releaseId: string, phase: string) => ({
  id: `a-${releaseId}`,
  releaseId,
  attempt: 1,
  cogniKey: `k-${releaseId}`,
  endpoints: [],
  phase,
  steps: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const releaseRow = (id: string, host: string, sha: string) => ({
  id,
  sourceSha: sha,
  spec: { name: "canary", kind: "app", expose: { http: { host } } },
});

describe("GET /api/v1/deploy/instances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: NODE_ID, slug: "operator" };
    dbState.billing = { id: "billing-1" };
    dbState.call = 0;
    authz.present = true;
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    envState.DEPLOY_ENVIRONMENT = "production";
    envState.NODE_DEPLOY_ENVS = undefined;
    envState.NODE_DEPLOY_WORKLOAD_ZONE = "cognidao.org";
    store.listDesired.mockResolvedValue([
      desired("canary", R(1)),
      desired("canary-stopped", R(2), "stopped"),
      { ...desired("foreign", R(3)), nodeId: OTHER_NODE },
    ]);
    store.attemptsFor.mockImplementation(async (key: { workload: string }) =>
      key.workload === "canary" ? [attempt(R(1), "active")] : []
    );
    store.getRelease.mockImplementation(async (id: string) =>
      id === R(1) ? releaseRow(R(1), CANARY_HOST, "a".repeat(40)) : undefined
    );
  });

  it("401 when unauthenticated; nothing is read", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await getInstances(QUERY)).status).toBe(401);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("400 for a missing env", async () => {
    expect((await getInstances(`?nodeId=${NODE_ID}`)).status).toBe(400);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("same authz gate as the deploy reads: a denial reads no rows; production -> node.promote_production", async () => {
    authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
    expect((await getInstances(QUERY)).status).toBe(403);
    expect(store.listDesired).not.toHaveBeenCalled();
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    dbState.call = 0;
    await getInstances(QUERY);
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "node.promote_production",
        resource: `node:${NODE_ID}`,
      })
    );
  });

  it("409 env_not_served for an env this deployment does not serve", async () => {
    const res = await getInstances(`?nodeId=${NODE_ID}&env=preview`);
    expect(res.status).toBe(409);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("lists only this node's running, proven instance, schema-valid", async () => {
    const res = await getInstances(QUERY);
    expect(res.status).toBe(200);
    const body = DeployInstancesReadSchema.parse(await res.json());
    expect(body).toMatchObject({ nodeId: NODE_ID, env: "production" });
    expect(body.instances).toEqual([
      {
        instance: "canary",
        workload: "canary",
        host: CANARY_HOST,
        releaseId: R(1),
        sourceSha: "a".repeat(40),
      },
    ]);
    // READ_ONLY: store reads only
    expect(store.listDesired).toHaveBeenCalledWith("production");
  });

  it("a canary that is not proven (no active attempt) is absent", async () => {
    store.attemptsFor.mockResolvedValue([attempt(R(1), "proving")]);
    const body = DeployInstancesReadSchema.parse(
      await (await getInstances(QUERY)).json()
    );
    expect(body.instances).toEqual([]);
  });

  it("503 when the workload zone is not configured", async () => {
    envState.NODE_DEPLOY_WORKLOAD_ZONE = undefined;
    const res = await getInstances(QUERY);
    expect(res.status).toBe(503);
    expect(store.listDesired).not.toHaveBeenCalled();
  });
});
