// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/bootstrap/agent-tool-authority`
 * Purpose: Qualify node composition and the caller-bound shared admin API.
 * Scope: Unit tests of wiring; no database or live grant writes.
 * Invariants: NO_DEFAULT_GRANTS; SAME_CALLER; NO_SELF_APPROVAL_IN_PACKAGE.
 * Side-effects: none
 * Links: hub agent-run-authority, story.0085
 * @internal
 */

import type { AuthorizationPort } from "@cogni/authorization-core";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { CORE_TOOL_BUNDLE } from "@cogni/shared-ai-tools";
import { AgentRolesError } from "@cogni-dao/agent-grants";
import type { AgentAuthoritySql } from "@cogni-dao/agent-grants/host";
import * as sharedHost from "@cogni-dao/agent-grants/host";
import {
  accessRequestCreateHttp,
  accessRequestListHttp,
  adminAiAccessHttp,
} from "@cogni-dao/agent-grants/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindAdminAiAccessCalls,
  createAgentToolAuthority,
} from "@/bootstrap/agent-tool-authority";
import { workItemRouteRequires } from "@/bootstrap/http/work-item-authority";

// Observe composition while retaining the published factory implementation.
vi.mock("@cogni-dao/agent-grants/host", { spy: true });

function adminAuthority() {
  return {
    adminCheck: vi.fn(async () => "allow" as const),
    listNodeAi: vi.fn(async () => ({ permissions: [], more: 0 })),
    grantRole: vi.fn(async () => ({
      principalUserId: "target",
      created: true,
    })),
    revokeRole: vi.fn(async () => ({
      principalUserId: "target",
      revoked: false,
    })),
    denyRequest: vi.fn(async () => ({
      principalUserId: "target",
      denied: true,
    })),
    previewAsk: vi.fn(async () => null),
  };
}

describe("published operator capability host", () => {
  afterEach(() => vi.clearAllMocks());

  it("uses the runtime catalog and existing node-admin check for either caller kind", async () => {
    const factory = vi.mocked(sharedHost.createAgentToolAuthority);
    const check = vi.fn<AuthorizationPort["check"]>().mockResolvedValue({
      decision: "allow",
      code: "authz_allowed",
      checks: [],
    });
    const authorization: AuthorizationPort = {
      check,
      listRelations: vi.fn(),
      listRelationsByObject: vi.fn(),
      writeRelation: vi.fn(),
      deleteRelation: vi.fn(),
    };
    const sql = Object.assign(vi.fn(), { begin: vi.fn() });
    createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      authorization,
      nodeId: "operator",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const deps = factory.mock.calls[0]?.[0];
    if (!deps) throw new Error("published factory was not called");
    expect(deps.graphs).toEqual(Object.values(LANGGRAPH_CATALOG));
    expect(deps.sql).toBe(sql);
    for (const userId of ["session-admin", "bearer-admin"]) {
      expect(await deps.nodeAdmin.check({ userId })).toEqual({ ok: true });
      expect(check).toHaveBeenLastCalledWith(
        expect.objectContaining({
          actorId: `user:${userId}`,
          action: "node.administer",
          context: { tenantId: "operator", nodeId: "operator" },
        })
      );
    }
    expect(sql).not.toHaveBeenCalled();
  });

  it("derives grantable permissions from released contracts without reading or seeding SQL", () => {
    const sql = Object.assign(vi.fn(), { begin: vi.fn() });
    const host = createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      authorization: undefined,
      nodeId: "operator",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    for (const scope of ["work_item:transition", "edo:write"]) {
      const contract = CORE_TOOL_BUNDLE.find(
        (tool) => tool.contract.requires?.scope === scope
      )?.contract.requires;
      expect(contract).toBeDefined();
      expect(host.permissions).toContainEqual({
        scope,
        kind: contract?.kind,
        label: contract?.label,
        description: contract?.description,
      });
    }
    // The host also carries its published knowledge route-only declarations.
    // No account, org, payment, profile or extra tool scope is introduced here.
    expect(host.declaredScopes).toEqual([
      "edo:write",
      "knowledge:contribute",
      "knowledge:read",
      "work_item:transition",
    ]);
    expect(
      host.permissions.every((permission) => permission.kind === "node")
    ).toBe(true);
    expect(sql).not.toHaveBeenCalled();
    expect(sql.begin).not.toHaveBeenCalled();
  });

  it("preserves the existing system classifier instead of adopting package seed IDs", async () => {
    // This classification is pure and must not query or seed users.
    const sql = Object.assign(vi.fn(), { begin: vi.fn() });
    const host = createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      authorization: undefined,
      nodeId: "operator",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(await host.principalClass(COGNI_SYSTEM_PRINCIPAL_USER_ID)).toBe(
      "system"
    );
    expect(sql).not.toHaveBeenCalled();
  });
});

describe("caller-bound admin calls", () => {
  it.each([
    "session-admin",
    "bearer-admin",
  ])("binds %s as approver for On, Off and dismiss", async (userId) => {
    const authority = adminAuthority();
    const binding = await bindAdminAiAccessCalls(authority, userId);
    expect(authority.adminCheck).toHaveBeenCalledExactlyOnceWith(userId);
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error("expected admin binding");

    const target = { ref: { principalSlug: "node-ai" }, scope: "edo:write" };
    expect(await binding.calls.on(target)).toEqual({
      principalUserId: "target",
      changed: true,
    });
    expect(await binding.calls.off(target)).toEqual({
      principalUserId: "target",
      changed: false,
    });
    expect(await binding.calls.dismiss(target)).toEqual({
      principalUserId: "target",
      changed: true,
    });
    const input = {
      principalSlug: "node-ai",
      scope: "edo:write",
      me: { userId, admin: { userId } },
    };
    expect(authority.grantRole).toHaveBeenCalledExactlyOnceWith(input);
    expect(authority.revokeRole).toHaveBeenCalledExactlyOnceWith(input);
    expect(authority.denyRequest).toHaveBeenCalledExactlyOnceWith(input);
    await binding.calls.preview("one-time-link");
    expect(authority.previewAsk).toHaveBeenCalledExactlyOnceWith({
      token: "one-time-link",
      resource: "node",
    });
    expect(await binding.calls.list()).toEqual({ permissions: [], more: 0 });
  });

  it.each([
    "denied",
    "unavailable",
    "throw",
  ] as const)("returns no callable admin surface on %s", async (decision) => {
    const authority = adminAuthority();
    const failed = {
      ...authority,
      adminCheck: async () => {
        if (decision === "throw") throw new Error("store outage");
        return decision;
      },
    };
    expect(await bindAdminAiAccessCalls(failed, "caller")).toMatchObject({
      ok: false,
      status: decision === "denied" ? 403 : 503,
      errorCode: decision === "denied" ? "authz_denied" : "authz_unavailable",
    });
    expect(authority.grantRole).not.toHaveBeenCalled();
    expect(authority.listNodeAi).not.toHaveBeenCalled();
  });

  it("preserves package refusals for the published HTTP core to map", async () => {
    const authority = adminAuthority();
    authority.grantRole.mockRejectedValueOnce(
      new AgentRolesError("self_approval", "cannot approve yourself")
    );
    const binding = await bindAdminAiAccessCalls(authority, "caller");
    if (!binding.ok) throw new Error("expected admin binding");
    const onUnavailable = vi.fn();
    const response = await adminAiAccessHttp({ onUnavailable }, "on", {
      body: { principalUserId: "caller", scope: "edo:write" },
      calls: binding.calls,
    });
    expect(response.status).toBe(403);
    expect(response.headers).toEqual({ "cache-control": "no-store" });
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});

describe("thin route inputs", () => {
  it("retains all existing work-item and coordination gates with the released route composer", () => {
    const policy = CORE_TOOL_BUNDLE.find(
      (tool) => tool.contract.name === "core__work_item_update"
    )?.contract.requires;
    expect(policy?.scope).toBe("work_item:transition");
    for (const route of [
      "work.items.create",
      "work.items.patch",
      "work.items.claim",
      "work.items.release",
      "work.items.heartbeat",
      "work.items.artifacts.create",
      "work.items.sessions.claim",
      "work.items.sessions.heartbeat",
      "work.items.sessions.pr",
    ]) {
      expect(workItemRouteRequires(route)).toEqual(policy);
    }
    for (const route of ["work.items.delete", "work.items.get", "edo.decide"])
      expect(workItemRouteRequires(route)).toBeUndefined();
  });

  it("passes a real host straight to both access-request HTTP cores", async () => {
    const sql = Object.assign(vi.fn(), { begin: vi.fn() });
    const authority = createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      authorization: undefined,
      nodeId: "operator",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const onUnavailable = vi.fn();
    // Published parsing refuses malformed JSON before any store call.
    const create = await accessRequestCreateHttp(
      { onUnavailable },
      {
        via: "bearer",
        principalUserId: "caller",
        body: {},
        origin: "https://test.cognidao.org",
        authority,
      }
    );
    expect(create.status).toBe(400);
    // The published access-request core retains its bearer-only contract.
    const list = await accessRequestListHttp(
      { onUnavailable },
      { via: "session", principalUserId: "caller", authority }
    );
    expect(list.status).toBe(404);
    expect(sql).not.toHaveBeenCalled();
    expect(sql.begin).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
