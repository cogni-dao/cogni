// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-authority`
 * Purpose: Prove HTTP/tool scope parity and the released adapter and principal seams.
 * Scope: Real HTTP wrapper, grant evaluator and package exports; fake SQL and session I/O.
 * Invariants: REVOKE_IS_IMMEDIATE; OUTAGE_IS_503; HUMAN_MEMBER_PRESERVED.
 * Side-effects: none
 * Links: hub agent-run-authority, adopt-node-package-release, story.0085
 * @internal
 */
import { readFileSync } from "node:fs";
import { OpenFgaAuthorizationAdapter } from "@cogni/authorization-core";
import { WorkItemRevisionConflictError as RootConflict } from "@cogni/work-items";
import { WorkItemRevisionConflictError as AdapterConflict } from "@cogni/work-items/adapters/doltgres";
import { type GuardDeps, guardTools } from "@cogni-dao/agent-grants";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import { createNodeCodeCapability } from "@/bootstrap/capabilities/node-code";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemRouteRequires } from "@/bootstrap/http/work-item-authority";

const state = vi.hoisted(() => ({
  bearer: true,
  live: true,
  outage: false,
  bootstrapFail: false,
  expectedScope: "work_item:transition",
  sql: vi.fn(),
  codeRead: vi.fn(async () => ({ content: "source" })),
}));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: async () => ({
    id: "admin",
    displayName: null,
    walletAddress: null,
    avatarColor: null,
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(state.bearer ? { authorization: "Bearer verified-key" } : {}),
}));
vi.mock("@/bootstrap/container", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return {
    getContainer: () => {
      if (state.bootstrapFail) throw new Error("EVM_RPC_URL missing");
      return {
        log,
        clock: { now: () => new Date(0) },
        config: { unhandledErrorPolicy: "rethrow" },
        nodeId: "operator",
      };
    },
    resolveServiceDb: () => ({ $client: state.sql }),
  };
});
// Keep the actual execution scope for the capability; only GitHub transport is replaced.
vi.mock("@/adapters/server", async () => ({
  ...(await import("@/adapters/server/ai/execution-scope")),
  ...(await import("@/adapters/server/ai/run-node-authorization")),
  REVIEW_NODE_CODE_POLICY: {},
  GitHubVcsAdapter: class {
    nodeCodeReader() {
      return { read: state.codeRead };
    }
  },
}));

const store = {
  hasLiveRole: async (principal: string, scope: string) => {
    if (state.outage) throw new Error("offline");
    return (
      state.live &&
      principal === "actual-agent" &&
      scope === "work_item:transition"
    );
  },
};
const authority: GuardDeps = {
  withStore: async (fn) =>
    fn(store as Parameters<Parameters<GuardDeps["withStore"]>[0]>[0]),
  adminCheck: async () => "denied",
};

beforeEach(() => {
  state.bearer = true;
  state.live = true;
  state.outage = false;
  state.bootstrapFail = false;
  state.expectedScope = "work_item:transition";
  state.sql.mockReset().mockImplementation(async (_strings, ...values) => {
    if (state.outage) throw new Error("offline");
    return state.live &&
      values.includes("actual-agent") &&
      values.includes(state.expectedScope)
      ? [{ "?column?": 1 }]
      : [];
  });
  state.codeRead.mockClear();
});

describe("published HTTP and graph work-item doors", () => {
  const routeIds = [
    "work.items.patch",
    "work.items.create",
    "work.items.claim",
    "work.items.release",
    "work.items.heartbeat",
    "work.items.artifacts.create",
    "work.items.sessions.claim",
    "work.items.sessions.heartbeat",
    "work.items.sessions.pr",
  ];
  it.each(
    routeIds
  )("enforces live allow, revoke and unavailable before %s writes", async (routeId) => {
    const requires = workItemRouteRequires(routeId);
    expect(requires?.scope).toBe("work_item:transition");
    if (!requires) throw new Error("missing declaration");
    const write = vi.fn(async () => NextResponse.json({ written: true }));
    const handler = wrapRouteHandlerWithLogging(
      {
        routeId,
        auth: {
          mode: "required",
          getSessionUser: async () => ({
            id: "actual-agent",
            displayName: null,
            walletAddress: null,
            avatarColor: null,
          }),
        },
      },
      write
    );
    const exec = vi.fn(
      async (_args: never, _ctx: never, _capabilities: never) => "written"
    );
    const tool = guardTools(
      { update: { id: "update", effect: "write", exec } },
      { update: requires },
      { principalId: "actual-agent" },
      authority
    ).update;
    if (!tool) throw new Error("missing tool");
    const call = () =>
      handler(
        new NextRequest("http://localhost/api/v1/work/items/task.1", {
          method: "PATCH",
        })
      );
    expect((await call()).status).toBe(200);
    await expect(
      tool.exec(undefined as never, undefined as never, undefined as never)
    ).resolves.toBe("written");
    state.live = false;
    const denied = await call();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ errorCode: "authz_denied" });
    await expect(
      tool.exec(undefined as never, undefined as never, undefined as never)
    ).rejects.toMatchObject({ receipt: { code: "policy_denied" } });
    state.outage = true;
    const unavailable = await call();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      errorCode: "authz_unavailable",
    });
    await expect(
      tool.exec(undefined as never, undefined as never, undefined as never)
    ).rejects.toMatchObject({ receipt: { code: "authz_unavailable" } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each(
    routeIds
  )("keeps human member access without live roles on %s", async (routeId) => {
    state.bearer = false;
    state.outage = true;
    const handler = wrapRouteHandlerWithLogging(
      {
        routeId,
        auth: {
          mode: "required",
          getSessionUser: async () => ({
            id: "human",
            displayName: null,
            walletAddress: null,
            avatarColor: null,
          }),
        },
      },
      async () => NextResponse.json({ written: true })
    );
    expect(
      (await handler(new NextRequest("http://localhost", { method: "PATCH" })))
        .status
    ).toBe(200);
    expect(state.sql).not.toHaveBeenCalled();
    expect(workItemRouteRequires("work.items.delete")).toBeUndefined();
    expect(
      workItemRouteRequires("work.items.sessions.coordination")
    ).toBeUndefined();
  });
});

it.each([
  ["edo.hypothesize", "edo:write"],
  ["edo.decide", "edo:write"],
  ["edo.record_outcome", "edo:write"],
  ["knowledge.list", "knowledge:read"],
  ["knowledge.get", "knowledge:read"],
  ["knowledge.index", "knowledge:read"],
  ["knowledge.contributions.create", "knowledge:contribute"],
  ["knowledge.contributions.commits.append", "knowledge:contribute"],
  ["knowledge.domains.create", "knowledge:contribute"],
])("checks live %s grant and denies before handler", async (routeId, scope) => {
  state.expectedScope = scope;
  const requires = workItemRouteRequires(routeId);
  expect(requires?.scope).toBe(scope);
  const write = vi.fn(async () => NextResponse.json({ ok: true }));
  const handler = wrapRouteHandlerWithLogging(
    {
      routeId,
      auth: {
        mode: "required",
        getSessionUser: async () => ({
          id: "actual-agent",
          displayName: null,
          walletAddress: null,
          avatarColor: null,
        }),
      },
    },
    write
  );
  const call = () =>
    handler(
      new NextRequest("http://localhost", {
        method:
          routeId.startsWith("knowledge.") && scope === "knowledge:read"
            ? "GET"
            : "POST",
      })
    );
  expect((await call()).status).toBe(200);
  state.live = false;
  expect((await call()).status).toBe(403);
  expect(write).toHaveBeenCalledTimes(1);
});

it.each([
  "on",
  "off",
  "dismiss",
] as const)("returns no-store 503 on %s store outage", async (call) => {
  const authority = await import("@/bootstrap/agent-tool-authority");
  const spy = vi.spyOn(authority, "getAdminAiAccessCalls").mockResolvedValue({
    ok: true,
    calls: {
      list: async () => ({ permissions: [], more: 0 }),
      on: async () => {
        throw new Error("secret store detail");
      },
      off: async () => {
        throw new Error("secret store detail");
      },
      dismiss: async () => {
        throw new Error("secret store detail");
      },
      preview: async () => null,
    },
  });
  const { adminRoute } = await import(
    "@/app/api/v1/admin/ai-access/admin-route"
  );
  const response = await adminRoute(call === "dismiss" ? "off" : call)(
    new NextRequest("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalUserId: "target",
        scope: "edo:write",
        ...(call === "dismiss" ? { deny: true } : {}),
      }),
    })
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "authz_unavailable" });
  spy.mockRestore();
});

it("serves discovery without runtime container readiness", async () => {
  state.bootstrapFail = true;
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("EVM_RPC_URL", "");
  vi.stubEnv("LITELLM_MASTER_KEY", "test-key");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/test");
  vi.stubEnv("DATABASE_SERVICE_URL", "postgresql://localhost/test");
  for (const key of [
    "AUTH_SECRET",
    "SCHEDULER_API_TOKEN",
    "BILLING_INGEST_TOKEN",
  ])
    vi.stubEnv(key, "x".repeat(32));
  const { GET } = await import("@/app/.well-known/agent.json/route");
  const response = await GET(
    new Request("http://localhost/.well-known/agent.json")
  );
  expect(response.status).toBe(200);
  expect(
    (await response.json()).permissions.map((p: { scope: string }) => p.scope)
  ).toEqual(
    expect.arrayContaining([
      "knowledge:read",
      "knowledge:contribute",
      "edo:write",
    ])
  );
});

it("maps conflicts from the exported adapter constructor, preserving the canonical receipt", async () => {
  expect(AdapterConflict).not.toBe(RootConflict);
  const conflict = new AdapterConflict("task.1" as never, 1, 2);
  const capability = createWorkItemCapability({
    workItemQuery: {} as never,
    backlogWriter: {
      attribution: () => ({ actor: "actual-agent" }) as never,
      attributionDenied: vi.fn(),
      store: {
        patch: async () => {
          throw conflict;
        },
      } as never,
    },
  });
  await expect(
    capability.patch({
      id: "task.1",
      reason: "Update rank",
      set: { rank: 1 },
    } as never)
  ).rejects.toMatchObject({
    id: "task.1",
    expectedRevision: 1,
    currentRevision: 2,
  });
});

it("uses a supported agent principal through the real FGA adapter for delegated code reads", async () => {
  const model = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../infra/openfga/rbac-model.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  const delegationTypes = model.type_definitions
    .find((type: { type: string }) => type.type === "user")
    .metadata.relations.delegates.directly_related_user_types.map(
      (type: { type: string }) => type.type
    );
  let principalLive = true;
  let delegationLive = true;
  const check = vi.fn(
    async (request: { user: string; relation: string; object: string }) => {
      if (
        request.relation === "delegates" &&
        !delegationTypes.includes(request.user.split(":")[0])
      )
        throw new Error("unsupported principal type");
      return {
        allowed:
          state.live &&
          (request.user !== "user:actual-agent" || principalLive) &&
          (request.relation !== "delegates" || delegationLive),
      };
    }
  );
  const authorization = new OpenFgaAuthorizationAdapter({
    apiUrl: "http://fga.invalid",
    storeId: "fixture",
    client: { check },
  });
  const code = createNodeCodeCapability({
    getAuthorization: () => authorization,
    nodeId: "operator",
    origin: "https://cognidao.org",
    owner: "cogni-dao",
    repo: "cogni",
    commitSha: "4073d018053b8c57aca6c477f79e2293aea414a2",
    appId: "123",
    privateKeyBase64: "a2V5",
    log: { info: vi.fn(), warn: vi.fn() },
  });
  const scope = {
    principalId: "actual-agent",
    subjectUserId: "requester",
    nodeId: "operator",
    billing: { billingAccountId: "payer" },
  } as never;
  await runInScope(scope, async () => {
    await expect(code.read({ path: "package.json" })).resolves.toMatchObject({
      content: "source",
    });
    expect(check).toHaveBeenCalledWith({
      user: "agent:actual-agent",
      relation: "delegates",
      object: "user:requester",
    });
    expect(check).toHaveBeenCalledWith({
      user: "user:actual-agent",
      relation: "can_flight",
      object: "node:operator",
    });
    principalLive = false;
    await expect(code.read({ path: "package.json" })).rejects.toThrow(
      "node_code_authz_denied"
    );
    principalLive = true;
    delegationLive = false;
    await expect(code.read({ path: "package.json" })).rejects.toThrow(
      "node_code_authz_denied"
    );
    delegationLive = true;
    state.live = false;
    await expect(code.read({ path: "package.json" })).rejects.toThrow(
      "node_code_authz_denied"
    );
    check.mockRejectedValue(new Error("offline"));
    await expect(code.read({ path: "package.json" })).rejects.toThrow(
      "node_code_authz_unavailable"
    );
    expect(state.codeRead).toHaveBeenCalledTimes(1);
  });
});
