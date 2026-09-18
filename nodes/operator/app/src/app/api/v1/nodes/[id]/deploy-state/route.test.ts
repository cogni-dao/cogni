// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/deploy-state` (test)
 * Purpose: Pin the money-loop read extension (story.5039 PR-B, reshaped by task.5138) — the
 *   deploy view carries this node's live paid-lease receipts plus the orphan diff, with closure
 *   honestly "unknown" (the app holds no Console key; authoritative closure proof is in-actuator,
 *   bug.5189), OMITS the block (never fabricates an empty one) when the lease capability is
 *   unwired, and degrades the same way when the ledger read fails.
 * Scope: Unit tests over mocked session/authz/container — no IO.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/deploy-state/route.ts, bug.5189, task.5138
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const getDeployState = vi.fn();
const listAllocated = vi.fn();

const NODE = { nodeId: "123e4567-e89b-12d3-a456-426614174001", slug: "blue" };

const container: {
  deployCapability: unknown;
  leaseReadCapability: unknown;
} = { deployCapability: undefined, leaseReadCapability: undefined };

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: authorize,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => container,
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ deployEnvs: ["candidate-a"] }],
        }),
      }),
    }),
  }),
}));
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: () => undefined }));
vi.mock("@/features/nodes/flight-status", () => ({
  FLIGHT_ENVS: ["candidate-a"],
}));
vi.mock("@/features/nodes/node-lookup", () => ({ nodeIdOrSlug: () => ({}) }));
vi.mock("@/shared/db/nodes", () => ({ nodes: {} }));
vi.mock("@/shared/observability", () => ({
  createRequestContext: () => ({
    reqId: "req-1",
    routeId: "nodes.deploy-state",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
  EVENT_NAMES: {
    NODE_DEPLOY_STATE_COMPLETE: "feature.node_deploy_state.complete",
  },
  logEvent: vi.fn(),
  makeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const DEPLOY_CELL = {
  env: "candidate-a",
  node: "blue",
  sourceSha: null,
  digest: null,
  buildSha: null,
  health: "healthy" as const,
  replicas: { desired: 1, ready: 1 },
};

const receiptOf = (environment: string, externalName: string) => ({
  receiptId: `r-${externalName}`,
  cogniKey: `xcw:cogni-${environment}-blue:blue:0`,
  identity: {
    nodeId: NODE.nodeId,
    compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
    compositeGeneration: 0,
  },
  environment,
  state: "allocated",
  externalName,
});

const get = async (): Promise<Response> => {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `https://operator.example/api/v1/nodes/${NODE.nodeId}/deploy-state`
    ),
    { params: Promise.resolve({ id: NODE.nodeId }) }
  );
};

describe("GET /api/v1/nodes/[id]/deploy-state — lease read (story.5039 PR-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true, node: NODE });
    getDeployState.mockResolvedValue(DEPLOY_CELL);
    container.deployCapability = { getDeployState };
    container.leaseReadCapability = { listAllocated };
  });

  it("returns leases with closure 'unknown' (no app-side Console read-back) AND the orphan diff", async () => {
    // One declared lease (candidate-a) still billing, one lease on an env the catalog no
    // longer declares (preview) — the undetectable orphan the unfiltered enumeration exists for.
    // Closure is honestly "unknown" for BOTH: the app holds no Console key (task.5138,
    // ONE_CONSOLE_KEY_PER_ACCOUNT) — the authoritative closure proof lives in-actuator (bug.5189).
    listAllocated.mockResolvedValue([
      receiptOf("candidate-a", "7001"),
      receiptOf("preview", "7002"),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Unfiltered by env — the orphan can only surface from the node-wide enumeration.
    expect(listAllocated).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE.nodeId })
    );
    expect(body.leases).toEqual([
      {
        environment: "candidate-a",
        cogniKey: "xcw:cogni-candidate-a-blue:blue:0",
        state: "allocated",
        externalName: "7001",
        closure: "unknown",
      },
      {
        environment: "preview",
        cogniKey: "xcw:cogni-preview-blue:blue:0",
        state: "allocated",
        externalName: "7002",
        closure: "unknown",
      },
    ]);
    // (preview, blue) is not in deployEnvs ["candidate-a"] → orphan.
    expect(body.orphans).toEqual([
      expect.objectContaining({ environment: "preview", externalName: "7002" }),
    ]);
  });

  it("OMITS the lease block when the capability is unwired — absent, not an empty lie", async () => {
    container.leaseReadCapability = undefined;
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("leases");
    expect(body).not.toHaveProperty("orphans");
    // The probe-backed half still serves.
    expect(body.liveEnvs).toEqual(["candidate-a"]);
  });

  it("degrades to an omitted block on a ledger read failure — the deploy view must not 500", async () => {
    listAllocated.mockRejectedValue(new Error("ledger unreachable"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("leases");
    expect(body.liveEnvs).toEqual(["candidate-a"]);
  });
});
