// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.developers`
 * Purpose: Contract tests for owner-gated node developer approval — OpenFGA tuple writes AND the
 *   rbac.md §6a GitHub branch-push provisioning side-effect.
 * Scope: Verifies POST /api/v1/nodes/[id]/developers validates ownership before OpenFGA writes, and
 *   that approval provisions / rejection de-provisions a node-repo collaborator for the agent's bound
 *   (or owner-attested) GitHub login — skipping safely when no login is resolvable.
 * Invariants: OWNER_GATING, OPENFGA_IS_AUTHORITY, TRUST_BOUNDARY_IS_MERGE_NOT_PUSH, PUSH_LOGIN_FROM_BINDING.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts, docs/spec/rbac.md §6a
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_USER_ID = "22222222-2222-4222-8222-222222222222";
const REPO_OWNER = "cogni-test-org";
const REPO_NAME = "test-cog";
const NODE_SLUG = "test-cog";

const authz = vi.hoisted(() => ({
  writeRelation: vi.fn(),
  deleteRelation: vi.fn(),
}));
const dbState = vi.hoisted(() => ({
  ownerNode: null as { id: string; slug: string } | null,
  agentUser: null as { id: string } | null,
  requestedGithubLogin: null as string | null,
  githubBinding: null as { login: string | null } | null,
}));
const deployPlane = vi.hoisted(() => ({
  setNodeCollaborator: vi.fn(),
  removeNodeCollaborator: vi.fn(),
  resolveNodeRepo: vi.fn(),
}));
const mockGetServerSessionUser = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

function rowsFrom<T>(rows: T[]): {
  from(): { where(): { limit(): T[] } };
} {
  return {
    from: () => ({
      where: () => ({
        limit: () => rows,
      }),
    }),
  };
}

const transitionRequest = vi.hoisted(() => vi.fn());

const mockAppDb = {
  select: () => rowsFrom(dbState.ownerNode ? [dbState.ownerNode] : []),
};
// The route runs three serviceDb selects, differentiated by projection key: agent-user existence
// (`id`), the access-request declared login (`githubLogin`), and the `user_bindings` fallback (`login`).
const mockServiceDb = {
  select: (proj?: Record<string, unknown>) => {
    if (proj && "githubLogin" in proj) {
      return rowsFrom([{ githubLogin: dbState.requestedGithubLogin }]);
    }
    if (proj && "login" in proj) {
      return rowsFrom(dbState.githubBinding ? [dbState.githubBinding] : []);
    }
    return rowsFrom(dbState.agentUser ? [dbState.agentUser] : []);
  },
  update: () => ({
    set: () => ({
      where: () => {
        transitionRequest();
        return Promise.resolve(undefined);
      },
    }),
  }),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    authorization: authz,
    clock: { now: () => "2026-06-08T00:00:00.000Z" },
    config: { unhandledErrorPolicy: "respond_500" },
    log: mockLogger,
  }),
  resolveAppDb: () => mockAppDb,
  resolveServiceDb: () => mockServiceDb,
}));

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => deployPlane,
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  }),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => mockGetServerSessionUser(),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockAppDb),
}));

import * as appHandler from "@/app/api/v1/nodes/[id]/developers/route";

describe("POST /api/v1/nodes/[id]/developers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.child.mockReturnValue(mockLogger);
    mockGetServerSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    authz.writeRelation.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
    authz.deleteRelation.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
    deployPlane.setNodeCollaborator.mockResolvedValue({ invitationId: null });
    deployPlane.removeNodeCollaborator.mockResolvedValue(undefined);
    deployPlane.resolveNodeRepo.mockResolvedValue({
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
    dbState.ownerNode = { id: NODE_ID, slug: NODE_SLUG };
    dbState.agentUser = { id: AGENT_USER_ID };
    dbState.requestedGithubLogin = null;
    dbState.githubBinding = null;
  });

  it("approves a developer; no GitHub login anywhere ⇒ tuple written, branch-push skipped", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: AGENT_USER_ID,
          decision: "approve",
          role: "developer",
          branchPush: "skipped:github_identity_unbound",
        });
      },
    });

    expect(authz.writeRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "developer",
      object: `node:${NODE_ID}`,
    });
    expect(authz.deleteRelation).not.toHaveBeenCalled();
    expect(deployPlane.setNodeCollaborator).not.toHaveBeenCalled();
    expect(transitionRequest).toHaveBeenCalled();
  });

  it("approve (no param) grants the login the agent declared on its request", async () => {
    // The human supplies NO githubLogin — it comes from the agent's own access request (§6a).
    dbState.requestedGithubLogin = "flock-leader";

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: AGENT_USER_ID,
          decision: "approve",
          role: "developer",
          branchPush: "granted",
        });
      },
    });

    expect(deployPlane.setNodeCollaborator).toHaveBeenCalledWith({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      login: "flock-leader",
      permission: "push",
    });
  });

  it("falls back to the github user_binding when the request declared no login", async () => {
    dbState.requestedGithubLogin = null;
    dbState.githubBinding = { login: "linked-dev" };

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect((await res.json()).branchPush).toBe("granted");
      },
    });

    expect(deployPlane.setNodeCollaborator).toHaveBeenCalledWith({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      login: "linked-dev",
      permission: "push",
    });
  });

  it("grants on the node's OWN repo (catalog source_repo), not the nodes-table parent", async () => {
    // Regression: the grant must target resolveNodeRepo()'s child repo (cogni-test-org/test-cog),
    // NOT nodes.repoOwner/repoName (the submodule-parent monorepo). The earlier bug granted on the
    // parent → "App not installed on Cogni-DAO/cogni (404)".
    dbState.requestedGithubLogin = "flock-leader";

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
      },
    });

    expect(deployPlane.resolveNodeRepo).toHaveBeenCalledWith(
      expect.objectContaining({ slug: NODE_SLUG })
    );
    expect(deployPlane.setNodeCollaborator).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "test-cog",
      login: "flock-leader",
      permission: "push",
    });
  });

  it("falls back to the parent monorepo when the node has no catalog row", async () => {
    dbState.requestedGithubLogin = "flock-leader";
    deployPlane.resolveNodeRepo.mockRejectedValue(
      Object.assign(new Error("catalog missing"), { code: "catalog_missing" })
    );

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect((await res.json()).branchPush).toBe("granted");
      },
    });

    expect(deployPlane.setNodeCollaborator).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      login: "flock-leader",
      permission: "push",
    });
  });

  it("invited outcome when GitHub returns a pending invitation", async () => {
    dbState.requestedGithubLogin = "flock-leader";
    deployPlane.setNodeCollaborator.mockResolvedValue({ invitationId: 999 });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect((await res.json()).branchPush).toBe("invited");
      },
    });
  });

  it("branch-push failure never reverses the authoritative tuple write", async () => {
    dbState.requestedGithubLogin = "flock-leader";
    deployPlane.setNodeCollaborator.mockRejectedValue(new Error("403 admin"));

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).branchPush).toBe("error");
      },
    });

    expect(authz.writeRelation).toHaveBeenCalled();
  });

  it("addresses by slug but writes the tuple to the resolved node_id (not the slug)", async () => {
    // The row's id (== repo-spec node_id) differs from the slug path segment. OpenFGA must key on
    // the resolved id, never the addressing slug.
    await testApiHandler({
      appHandler,
      params: { id: "beacon" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).nodeId).toBe(NODE_ID);
      },
    });

    expect(authz.writeRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "developer",
      object: `node:${NODE_ID}`,
    });
  });

  it("approves a registered agent as production_promoter (role-aware, no branch-push)", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
            role: "production_promoter",
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: AGENT_USER_ID,
          decision: "approve",
          role: "production_promoter",
          branchPush: "skipped:not_developer_role",
        });
      },
    });

    expect(authz.writeRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "production_promoter",
      object: `node:${NODE_ID}`,
    });
    expect(deployPlane.setNodeCollaborator).not.toHaveBeenCalled();
  });

  it("rejects by removing the developer tuple AND de-provisioning branch-push", async () => {
    dbState.requestedGithubLogin = "flock-leader";

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "reject",
          }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).branchPush).toBe("revoked");
      },
    });

    expect(authz.deleteRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "developer",
      object: `node:${NODE_ID}`,
    });
    expect(authz.writeRelation).not.toHaveBeenCalled();
    expect(deployPlane.removeNodeCollaborator).toHaveBeenCalledWith({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      login: "flock-leader",
    });
  });

  it("reject without a resolvable login skips de-provision (no orphaned removeNodeCollaborator)", async () => {
    // V0 owner-attest gap (rbac.md §6a): no `github` binding + no githubLogin on the reject ⇒ the
    // collaborator can't be auto-removed. The tuple delete is still authoritative; branch-push de-prov
    // is skipped + warned, never a silent wrong-arg removeNodeCollaborator call.
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "reject",
          }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).branchPush).toBe(
          "skipped:github_identity_unbound"
        );
      },
    });

    expect(authz.deleteRelation).toHaveBeenCalled();
    expect(deployPlane.removeNodeCollaborator).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "branch_push_deprovision_skipped" }),
      "branch_push_deprovision_skipped"
    );
  });

  it("does not write OpenFGA when the caller is not node owner", async () => {
    dbState.ownerNode = null;

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(404);
      },
    });

    expect(authz.writeRelation).not.toHaveBeenCalled();
    expect(authz.deleteRelation).not.toHaveBeenCalled();
    expect(deployPlane.setNodeCollaborator).not.toHaveBeenCalled();
  });
});
