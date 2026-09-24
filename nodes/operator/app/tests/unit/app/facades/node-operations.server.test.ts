// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Integrated access-first facade coverage for the node operations read model. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  owned: [] as Array<{
    id: string;
    slug: string;
    status: "active" | "published";
    daoAddress: null;
    chainId: null;
    deployEnvs: string[];
    createdAt: Date;
  }>,
}));
const reportByNodeIds = vi.hoisted(() => vi.fn());
const listPublic = vi.hoisted(() => vi.fn());
const listForeignEpochs = vi.hoisted(() => vi.fn());
const listServices = vi.hoisted(() => vi.fn());
const getDeployState = vi.hoisted(() => vi.fn());

const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: () => state.owned }),
      }),
    }),
  }),
};

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: typeof mockTx) => unknown
  ) => run(mockTx),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
  resolveComputeCostStore: () => ({ reportByNodeIds }),
  resolveNodeDeploymentTopology: () => ({ listServices }),
  resolveNodeRegistry: () => ({ listPublic }),
  getContainer: () => ({
    deployCapability: { getDeployState },
    epochsRead: { listEpochsForForeignNode: listForeignEpochs },
    attributionStore: { listEpochs: vi.fn() },
  }),
}));

vi.mock("@/shared/config", () => ({
  getNodeId: () => "33333333-3333-4333-8333-333333333333",
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    DOMAIN: "cognidao.org",
    DEPLOY_ENVIRONMENT: "production",
  }),
}));

import { listAccessibleNodeOperations } from "@/app/_facades/nodes/operations.server";

function cost(nodeId: string) {
  return {
    nodeId,
    allocatedIntervals: 0,
    activeIntervals: 1,
    closedIntervals: 0,
    transferred: [{ amount: "10000", denom: "uact" }],
    activeRates: [],
  };
}

describe("listAccessibleNodeOperations", () => {
  beforeEach(() => {
    state.owned = [];
    reportByNodeIds.mockReset();
    listPublic.mockReset();
    listForeignEpochs.mockReset();
    listServices.mockReset();
    getDeployState.mockReset();
    listPublic.mockResolvedValue([]);
    listForeignEpochs.mockResolvedValue({ epochs: [] });
    listServices.mockResolvedValue([
      { name: "app", visibility: "public" },
      { name: "paper-trader", visibility: "private" },
    ]);
    getDeployState.mockImplementation(
      ({ env, node }: { env: string; node: string }) =>
        Promise.resolve({
          env,
          node,
          sourceSha: "abc123",
          digest: null,
          buildSha: "abc123",
          health: "healthy",
          replicas: { desired: 1, ready: 1 },
        })
    );
  });

  it("passes only owner-resolved ids to cost SQL and cannot return an unrelated node", async () => {
    state.owned = [
      {
        id: NODE_A,
        slug: "alpha",
        status: "active",
        daoAddress: null,
        chainId: null,
        deployEnvs: ["production"],
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
      },
    ];
    // Even a defensive malicious/stale adapter result cannot create a node the access query omitted.
    reportByNodeIds.mockResolvedValue([cost(NODE_A), cost(NODE_B)]);

    const output = await listAccessibleNodeOperations("user-a");

    expect(reportByNodeIds).toHaveBeenCalledExactlyOnceWith([NODE_A]);
    expect(output.nodes.map((node) => node.id)).toEqual([NODE_A]);
    expect(listServices).toHaveBeenCalledExactlyOnceWith({
      slug: "alpha",
      environment: "production",
    });
    expect(JSON.stringify(output)).not.toContain(NODE_B);
    expect(output.nodes[0]).toMatchObject({
      relationship: "owner",
      detailUrl: `/nodes/${NODE_A}`,
      thumbnailUrl: null,
      modules: {
        deployment: {
          state: "available",
        },
      },
    });
    const production =
      output.nodes[0]?.modules.deployment.state === "available"
        ? output.nodes[0].modules.deployment.environments.find(
            (environment) => environment.env === "production"
          )
        : undefined;
    expect(production).toMatchObject({
      services: {
        state: "available",
        items: [
          { name: "app", visibility: "public" },
          { name: "paper-trader", visibility: "private" },
        ],
      },
      compute: { state: "available" },
    });
  });

  it("short-circuits all cost and catalog reads when the principal has no nodes", async () => {
    await expect(listAccessibleNodeOperations("user-empty")).resolves.toEqual({
      nodes: [],
    });
    expect(reportByNodeIds).not.toHaveBeenCalled();
    expect(listPublic).not.toHaveBeenCalled();
    expect(listForeignEpochs).not.toHaveBeenCalled();
    expect(listServices).not.toHaveBeenCalled();
  });

  it("degrades only service topology when the node repo cannot be read", async () => {
    state.owned = [
      {
        id: NODE_A,
        slug: "alpha",
        status: "active",
        daoAddress: null,
        chainId: null,
        deployEnvs: ["production"],
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
      },
    ];
    reportByNodeIds.mockResolvedValue([]);
    listServices.mockRejectedValue(new Error("unavailable"));

    const output = await listAccessibleNodeOperations("user-a");

    expect(output.nodes[0]?.modules.deployment).toMatchObject({
      state: "available",
      status: "healthy",
      environments: expect.arrayContaining([
        expect.objectContaining({
          env: "production",
          services: { state: "unavailable" },
        }),
      ]),
    });
  });
});
