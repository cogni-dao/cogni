// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.workloads.lanes`
 * Purpose: Contract tests for GET /api/v1/deploy/workloads/lanes (task.5479): the lane view shares the
 *   deploy reads' authz gate and addressing, reads nothing on a denial, answers the bug.5621 shape
 *   (serving, in flight, trailing-24h supersede history, KPIs) and satisfies `DeployLanesReadSchema`.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: a denial reads no desired row and no release history.
 *   - READ_ONLY: the route calls only store reads and the release source's `releases`.
 * Side-effects: none
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeployLanesReadSchema } from "@/contracts/deploy.workloads.v1.contract";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const OTHER_NODE = "00000000-0000-4000-8000-000000000009";

const store = vi.hoisted(() => ({
  getDesired: vi.fn(),
  listDesired: vi.fn(),
  attemptsFor: vi.fn(),
  getRelease: vi.fn(),
}));
const releaseSource = vi.hoisted(() => ({ releases: vi.fn() }));
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
  NODE_DEPLOY_WORKLOAD_ZONE: undefined as string | undefined,
  FLEET_CONTROL_ENV: "production",
}));
const catalogState = vi.hoisted(() => ({
  sourceRepo: "https://github.com/cogni-dao/owned",
}));
vi.mock("@/bootstrap/capabilities/node-catalog", () => ({
  createNodeCatalog: () => ({
    entryFor: async () => ({
      slug: "owned",
      row: {
        source_repo: catalogState.sourceRepo,
        compute_api: { preview: "node-deploy", production: "node-deploy" },
      },
    }),
  }),
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

vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => store,
}));
vi.mock("@/bootstrap/capabilities/node-deploy-release-source", () => ({
  createDeliveryReleaseSource: () => releaseSource,
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
      routeId: "deploy.workloads.lanes",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as lanesHandler from "@/app/api/v1/deploy/workloads/lanes/route";

async function getLanes(query: string) {
  let res!: Response;
  await testApiHandler({
    appHandler: lanesHandler,
    url: `/api/v1/deploy/workloads/lanes${query}`,
    async test({ fetch }) {
      res = await fetch({ method: "GET" });
    },
  });
  return res;
}

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000);
const R = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const QUERY = `?nodeId=${NODE_ID}&env=production`;
const facts = (n: number, over: Record<string, unknown>) => ({
  releaseId: R(n),
  nodeId: NODE_ID,
  env: "production",
  workload: "canary",
  sourceSha: String(n).repeat(40),
  createdBy: `user:u${n}`,
  admissionRefusalReason: undefined,
  createdAt: ago(0),
  activatedAt: undefined,
  activatedStepAt: undefined,
  served: false,
  parkedAt: undefined,
  parkStepSeen: false,
  current: false,
  firstActivatedAttempt: undefined,
  failedBeforeActivation: false,
  ...over,
});
const releaseRow = (n: number, createdAt: Date) => ({
  id: R(n),
  nodeId: NODE_ID,
  env: "production",
  workload: "canary",
  sourceSha: String(n).repeat(40),
  createdBy: `user:u${n}`,
  createdAt,
});
const desiredRow = {
  nodeId: NODE_ID,
  env: "production",
  workload: "canary",
  state: "running",
  releaseId: R(3),
  updatedAt: ago(5),
};
const attempt = (n: number, releaseId: string, phase: string) => ({
  id: `a-${n}`,
  releaseId,
  attempt: 1,
  cogniKey: `k-${n}`,
  externalName: undefined,
  provider: undefined,
  endpoints: [],
  phase,
  error: undefined,
  unhealthySince: undefined,
  createdAt: ago(20 - n),
  leasedAt: undefined,
  updatedAt: ago(10),
  steps: [],
});

describe("GET /api/v1/deploy/workloads/lanes", () => {
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
    catalogState.sourceRepo = "https://github.com/cogni-dao/owned";
    store.listDesired.mockResolvedValue([
      desiredRow,
      { ...desiredRow, nodeId: OTHER_NODE, workload: "foreign" },
    ]);
    store.getRelease.mockImplementation(async (id: string) =>
      id === R(3)
        ? releaseRow(3, ago(15))
        : id === R(1)
          ? releaseRow(1, ago(60))
          : undefined
    );
    store.attemptsFor.mockResolvedValue([
      attempt(3, R(3), "proving"),
      attempt(1, R(1), "active"),
    ]);
    releaseSource.releases.mockResolvedValue({
      rows: [
        facts(1, {
          createdAt: ago(60),
          activatedAt: ago(55),
          served: true,
          firstActivatedAttempt: 1,
        }),
        facts(2, { createdAt: ago(30) }),
        facts(3, { createdAt: ago(15), current: true }),
      ],
      truncated: false,
      asOf: new Date(NOW),
    });
  });

  it("401 when unauthenticated; nothing is read", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await getLanes(QUERY)).status).toBe(401);
    expect(store.listDesired).not.toHaveBeenCalled();
    expect(releaseSource.releases).not.toHaveBeenCalled();
  });

  it("400 for a missing env", async () => {
    expect((await getLanes(`?nodeId=${NODE_ID}`)).status).toBe(400);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("same authz gate as the deploy reads: a denial reads no rows; production -> node.promote_production", async () => {
    authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
    expect((await getLanes(QUERY)).status).toBe(403);
    expect(store.listDesired).not.toHaveBeenCalled();
    expect(releaseSource.releases).not.toHaveBeenCalled();
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    dbState.call = 0;
    await getLanes(QUERY);
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "node.promote_production",
        resource: `node:${NODE_ID}`,
      })
    );
  });

  it("409 env_not_served for an env this deployment does not serve", async () => {
    const res = await getLanes(`?nodeId=${NODE_ID}&env=preview`);
    expect(res.status).toBe(409);
    expect(store.listDesired).not.toHaveBeenCalled();
  });

  it("answers serving, in flight, supersede history and KPIs for this node's lane only, schema-valid", async () => {
    const res = await getLanes(QUERY);
    expect(res.status).toBe(200);
    const body = DeployLanesReadSchema.parse(await res.json());
    expect(body).toMatchObject({
      nodeId: NODE_ID,
      env: "production",
      truncated: false,
    });
    expect(body.lanes.map((l) => l.workload)).toEqual(["canary"]);
    const lane = body.lanes[0];
    expect(lane?.serving).toMatchObject({
      releaseId: R(1),
      sha8: "11111111",
      requestedBy: "user:u1",
    });
    expect(lane?.inFlight).toMatchObject({
      releaseId: R(3),
      state: "deploying",
      requestedBy: "user:u3",
      attempts: 1,
    });
    expect(lane?.history24h).toHaveLength(1);
    expect(lane?.history24h[0]).toMatchObject({
      releaseId: R(2),
      outcome: "superseded",
      requestedBy: "user:u2",
      supersededBy: { releaseId: R(3), requestedBy: "user:u3" },
    });
    expect(lane?.kpis.last24h).toMatchObject({
      activated: 1,
      parked: 0,
      successRatio: 1,
      superseded: 1,
    });
    // READ_ONLY: one release read scoped to this node + env, no writes anywhere.
    expect(releaseSource.releases).toHaveBeenCalledTimes(1);
    expect(releaseSource.releases.mock.calls[0]?.[0]).toMatchObject({
      scope: { nodeId: NODE_ID, env: "production" },
    });
  });

  it("a truncated release read is reported, not hidden", async () => {
    releaseSource.releases.mockResolvedValue({
      rows: [],
      truncated: true,
      asOf: new Date(NOW),
    });
    const body = DeployLanesReadSchema.parse(
      await (await getLanes(QUERY)).json()
    );
    expect(body.truncated).toBe(true);
  });

  it("500 read_failed when the release read fails", async () => {
    releaseSource.releases.mockRejectedValue(new Error("db down"));
    const res = await getLanes(QUERY);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "read_failed" });
  });
});
