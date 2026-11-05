// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.workloads.release`
 * Purpose: Contract tests for GET /api/v1/deploy/workloads/releases/{releaseId} and the additive
 *   release-state fields of GET /api/v1/deploy/workloads (task.5400 observability): same authz gate as
 *   the list, no cross-node or cross-env reads, a PARKED release is explicit, bodies satisfy the
 *   `deploy.workloads.v1` schemas.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: a denial reads no release row.
 *   - NO_CROSS_NODE_READ: another node's (or env's) release id answers 404 exactly like a missing one.
 * Side-effects: none
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeployReleaseDetailSchema,
  DeployWorkloadsReadSchema,
} from "@/contracts/deploy.workloads.v1.contract";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const OTHER_NODE = "00000000-0000-4000-8000-000000000009";
const R1 = "6b564b98-7a28-4a7f-8b17-c65a1b3e2c96";
const SHA = "a".repeat(40);
const T0 = new Date("2026-11-02T10:00:00.000Z");

const store = vi.hoisted(() => ({
  getDesired: vi.fn(),
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
      routeId: "deploy.workloads.release",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as releaseHandler from "@/app/api/v1/deploy/workloads/releases/[releaseId]/route";
import * as listHandler from "@/app/api/v1/deploy/workloads/route";

async function getRelease(releaseId: string, query: string) {
  let res!: Response;
  await testApiHandler({
    appHandler: releaseHandler,
    params: { releaseId },
    url: `/api/v1/deploy/workloads/releases/${releaseId}${query}`,
    async test({ fetch }) {
      res = await fetch({ method: "GET" });
    },
  });
  return res;
}

async function getList(query: string) {
  let res!: Response;
  await testApiHandler({
    appHandler: listHandler,
    url: `/api/v1/deploy/workloads${query}`,
    async test({ fetch }) {
      res = await fetch({ method: "GET" });
    },
  });
  return res;
}

const release = {
  id: R1,
  nodeId: NODE_ID,
  env: "production",
  workload: "canary",
  sourceSha: SHA,
  createdAt: T0,
};
const failedAttempt = (n: number, error: string) => ({
  id: `a-${n}`,
  releaseId: R1,
  attempt: n,
  cogniKey: `nd:ns:${NODE_ID}:canary:${R1}:${n}`,
  externalName: String(1000 + n),
  provider: "akash1provider",
  endpoints: [],
  phase: "failed",
  error,
  unhealthySince: undefined,
  createdAt: new Date(T0.getTime() + n * 1000),
  leasedAt: undefined,
  updatedAt: new Date(T0.getTime() + n * 1000),
  steps: [
    {
      step: "attempt_failed",
      outcome: "failed",
      reason: error,
      at: "2026-11-02T10:05:00.000Z",
    },
  ],
});
const parkedAttempts = [
  failedAttempt(3, "proof_timeout: version 502"),
  failedAttempt(2, "lease_not_ready"),
  failedAttempt(1, "proof_timeout: version 502"),
];
const QUERY = `?nodeId=${NODE_ID}&env=production`;

describe("GET /api/v1/deploy/workloads/releases/{releaseId}", () => {
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
    store.getRelease.mockResolvedValue(release);
    store.getDesired.mockResolvedValue({ state: "running", releaseId: R1 });
    store.attemptsFor.mockResolvedValue(parkedAttempts);
  });

  it("401 when unauthenticated; nothing is read", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect((await getRelease(R1, QUERY)).status).toBe(401);
    expect(store.getRelease).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid release id", "not-a-uuid", QUERY],
    ["a missing env", R1, `?nodeId=${NODE_ID}`],
  ])("400 for %s", async (_name, id, query) => {
    expect((await getRelease(id, query)).status).toBe(400);
    expect(store.getRelease).not.toHaveBeenCalled();
  });

  it("same authz gate as the list: 403 on denial reads no release; production -> node.promote_production", async () => {
    authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
    expect((await getRelease(R1, QUERY)).status).toBe(403);
    expect(store.getRelease).not.toHaveBeenCalled();
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    dbState.call = 0;
    await getRelease(R1, QUERY);
    expect(authz.check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "node.promote_production",
        resource: `node:${NODE_ID}`,
      })
    );
  });

  it("409 env_not_served for an env this deployment does not serve", async () => {
    const res = await getRelease(R1, `?nodeId=${NODE_ID}&env=preview`);
    expect(res.status).toBe(409);
    expect(store.getRelease).not.toHaveBeenCalled();
  });

  it("answers a PARKED release with its state, reason and per-attempt step timeline", async () => {
    const res = await getRelease(R1, QUERY);
    expect(res.status).toBe(200);
    const body = DeployReleaseDetailSchema.parse(await res.json());
    expect(body.release).toMatchObject({
      releaseId: R1,
      current: true,
      releaseState: "parked",
      parkedReason:
        "3 consecutive failed attempts; last: proof_timeout: version 502",
      activatedAt: null,
      leadTimeMs: null,
    });
    expect(body.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(body.attempts[0]?.steps[0]).toMatchObject({
      step: "attempt_failed",
      reason: "proof_timeout: version 502",
    });
  });

  it("another node's release is a 404 identical to a missing one (no cross-node read)", async () => {
    store.getRelease.mockResolvedValue({ ...release, nodeId: OTHER_NODE });
    const foreign = await getRelease(R1, QUERY);
    dbState.call = 0;
    store.getRelease.mockResolvedValue(undefined);
    const missing = await getRelease(R1, QUERY);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "release_not_found" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "release_not_found" });
    expect(store.attemptsFor).not.toHaveBeenCalled();
  });

  it("a release of another env is a 404 too", async () => {
    store.getRelease.mockResolvedValue({ ...release, env: "preview" });
    expect((await getRelease(R1, QUERY)).status).toBe(404);
  });
});

describe("GET /api/v1/deploy/workloads (release state, additive)", () => {
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
  });

  it("exposes releaseState + parkedReason on desired and steps on every attempt, schema-valid", async () => {
    store.listDesired.mockResolvedValue([
      {
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
        state: "running",
        releaseId: R1,
        updatedAt: T0,
      },
    ]);
    store.getRelease.mockResolvedValue(release);
    store.attemptsFor.mockResolvedValue(parkedAttempts);
    const res = await getList(QUERY);
    expect(res.status).toBe(200);
    const body = DeployWorkloadsReadSchema.parse(await res.json());
    const [w] = body.workloads;
    expect(w?.desired).toMatchObject({
      state: "running",
      releaseId: R1,
      sourceSha: SHA,
      releaseState: "parked",
      startedAt: new Date(T0.getTime() + 1000).toISOString(),
      leadTimeMs: null,
    });
    expect(w?.desired.parkedReason).toMatch(/^3 consecutive failed attempts/);
    expect(w?.active).toBeNull();
    expect(w?.recentAttempts[0]?.steps).toHaveLength(1);
  });
});

describe("existing remote release reads during DNS admission failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: OTHER_NODE, slug: "owned" };
    dbState.billing = { id: "billing-1" };
    dbState.call = 0;
    authz.present = true;
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    envState.DEPLOY_ENVIRONMENT = "production";
    envState.NODE_DEPLOY_ENVS = "candidate-a,preview,production";
    catalogState.sourceRepo = "https://github.com/cogni-dao/owned";
  });
  it.each([
    undefined,
    "https://invalid/zone",
  ])("reads owned list/detail with %s zone and keeps denials", async (zone) => {
    envState.NODE_DEPLOY_WORKLOAD_ZONE = zone;
    const ownedRelease = { ...release, nodeId: OTHER_NODE, env: "preview" };
    const desired = {
      nodeId: OTHER_NODE,
      env: "preview",
      workload: "canary",
      state: "running",
      releaseId: R1,
      updatedAt: T0,
    };
    store.getRelease.mockResolvedValue(ownedRelease);
    store.getDesired.mockResolvedValue(desired);
    store.listDesired.mockResolvedValue([
      desired,
      { ...desired, nodeId: NODE_ID },
    ]);
    store.attemptsFor.mockResolvedValue(parkedAttempts);
    const query = `?nodeId=${OTHER_NODE}&env=preview`;
    const read = async (detail: boolean, q = query) => {
      dbState.call = 0;
      return detail ? getRelease(R1, q) : getList(q);
    };
    expect(
      DeployWorkloadsReadSchema.parse(await (await read(false)).json())
        .workloads
    ).toHaveLength(1);
    expect(
      DeployReleaseDetailSchema.parse(await (await read(true)).json()).release
        .releaseId
    ).toBe(R1);
    for (const detail of [false, true]) {
      store.getRelease.mockClear();
      store.listDesired.mockClear();
      authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
      expect(
        (await read(detail, `?nodeId=${OTHER_NODE}&env=production`)).status
      ).toBe(403);
      expect(authz.check).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "node.promote_production" })
      );
      expect(store.getRelease).not.toHaveBeenCalled();
      expect(store.listDesired).not.toHaveBeenCalled();
      authz.check.mockResolvedValue({
        decision: "allow",
        code: "authz_allowed",
      });
      catalogState.sourceRepo = "https://github.com/foreign/owned";
      expect((await read(detail)).status).toBe(409);
      expect(store.getRelease).not.toHaveBeenCalled();
      expect(store.listDesired).not.toHaveBeenCalled();
      catalogState.sourceRepo = "https://github.com/cogni-dao/owned";
      envState.NODE_DEPLOY_ENVS = "production";
      expect((await read(detail)).status).toBe(409);
      envState.NODE_DEPLOY_ENVS = "candidate-a,preview,production";
    }
    store.getRelease.mockResolvedValue({ ...ownedRelease, nodeId: NODE_ID });
    expect((await read(true)).status).toBe(404);
    store.getRelease.mockResolvedValue({ ...ownedRelease, env: "production" });
    expect((await read(true)).status).toBe(404);
  });
});
