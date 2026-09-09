// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/nodes-detail-page`
 * Purpose: Regression coverage for owner-scoped node detail lookup by slug.
 * Scope: Page query wiring only; DB, auth, environment, and child UI are mocked.
 * Invariants: SLUG_NEVER_REACHES_UUID_PREDICATE, OWNER_SCOPE_IS_RETAINED.
 * Side-effects: none
 * Links: src/app/(app)/nodes/[id]/page.tsx, src/features/nodes/node-lookup.ts, bug.5112
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn();
  const nodeRow = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    ownerUserId: "owner-user",
    status: "dao_pending",
    daoAddress: null,
    chainId: null,
    operatorWalletAddress: null,
    splitAddress: null,
    publishPrUrl: null,
    failureReason: null,
  };

  return {
    nodes: {
      id: "nodes.id",
      slug: "nodes.slug",
      ownerUserId: "nodes.ownerUserId",
    },
    nodeIdOrSlug: vi.fn((value: string) => ({
      kind: "node-id-or-slug",
      value,
    })),
    where,
    tx: {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            where(condition);
            return { limit: async () => [nodeRow] };
          },
        }),
      }),
    },
  };
});

vi.mock("@/shared/db/nodes", () => ({ nodes: mocks.nodes }));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  eq: (column: string, value: string) => {
    if (column === mocks.nodes.id && value === "atlas") {
      throw new Error("invalid input syntax for type uuid");
    }
    return { kind: "eq", column, value };
  },
}));

vi.mock("@/features/nodes/node-lookup", () => ({
  nodeIdOrSlug: mocks.nodeIdOrSlug,
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: typeof mocks.tx) => unknown
  ) => run(mocks.tx),
}));

vi.mock("@cogni/ids", () => ({ userActor: (id: string) => ({ id }) }));
vi.mock("@cogni/node-shared", () => ({ getDaoUrl: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ({ id: "owner-user" }),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ deployCapability: null }),
  resolveAppDb: () => ({}),
  resolveNodeDistributionConfigResolver: vi.fn(),
  resolveServiceDb: vi.fn(),
}));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: vi.fn(),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ NODE_MINT_OWNER: undefined, DOLTHUB_OWNER: undefined }),
}));
vi.mock("@/shared/config", () => ({
  getNodeId: vi.fn(),
  getNodeTokenomicsConfig: vi.fn(),
}));
vi.mock("@/features/nodes/access-requests", () => ({
  listAccessRequests: vi.fn(),
}));
vi.mock("@/features/nodes/flight-status", () => ({ FLIGHT_ENVS: [] }));
vi.mock("@/features/nodes/launch-pack", () => ({
  nodeRepoUrlForSlug: () => null,
}));
vi.mock("@/shared/node-app-scaffold/knowledge-remote", () => ({
  buildNodeKnowledgeRemote: vi.fn(),
  knowledgeRemoteWebUrl: vi.fn(),
}));
vi.mock("@/components", () => ({ PageContainer: vi.fn() }));
vi.mock("@/features/nodes/access/NodeAccess", () => ({ NodeAccess: vi.fn() }));
vi.mock("@/features/nodes/DistributionsCard.client", () => ({
  DistributionsCard: vi.fn(),
}));
vi.mock("@/features/nodes/deployments/NodeDeployments", () => ({
  NodeDeployments: vi.fn(),
}));
vi.mock("@/features/nodes/ResetDaoDangerZone.client", () => ({
  ResetDaoDangerZone: vi.fn(),
}));
vi.mock("@/features/nodes/wizard/NodeWizard.client", () => ({
  NodeWizard: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));

import NodeDashboardPage from "@/app/(app)/nodes/[id]/page";

describe("node detail page lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a slug without sending it to the UUID column and retains owner scope", async () => {
    await expect(
      NodeDashboardPage({ params: Promise.resolve({ id: "atlas" }) })
    ).resolves.toBeDefined();

    expect(mocks.nodeIdOrSlug).toHaveBeenCalledWith("atlas");
    expect(mocks.where).toHaveBeenCalledWith({
      kind: "and",
      conditions: [
        { kind: "node-id-or-slug", value: "atlas" },
        { kind: "eq", column: "nodes.ownerUserId", value: "owner-user" },
      ],
    });
  });
});
