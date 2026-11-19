// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.push-token`
 * Purpose: Contract tests for POST /api/v1/vcs/push-token (a node AI's one-repo, 1-hour GitHub token).
 * Scope: Route behavior with the real route, real env-to-minter factory and the real contract schema;
 *   OpenFGA is the deterministic fake, GitHub is the stubbed minter. Each test names the defect it guards.
 * Invariants:
 *   - PUSH_IS_ITS_OWN_GATE: `node.push` (can_push, the `pusher` role) authorizes; `node.flight` does not.
 *   - NO_REPO_FROM_AGENT: the minted repo is the catalog's, never the body's.
 *   - REPO_ISOLATION: node A's principal never gets a token for node B or the operator monorepo.
 *   - TOKEN_NEVER_LOGGED: no log call carries the token.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/push-token/route.ts,
 *   packages/node-contracts/src/vcs.push-token.v1.contract.ts
 * @internal
 */

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import {
  PUSH_TOKEN_PERMISSIONS,
  pushTokenOperation,
} from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";
const SLUG_A = "creative";
const SLUG_B = "research";
const TOKEN = "ghs_SYNTHETIC_PUSH_TOKEN_0123456789";
const MONOREPO = { owner: "cogni-test-org", repo: "cogni-monorepo" };

const mockMint = vi.hoisted(() => vi.fn());
const mockResolveNodeRepo = vi.hoisted(() => vi.fn());
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const authzHolder = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: InstanceType<typeof FakeAuthorizationAdapter> | null;
    }
);
const dbState = vi.hoisted(() => ({
  byId: {} as Record<string, { nodeId: string; slug: string }>,
}));
const envState = vi.hoisted(() => ({
  current: {} as Record<string, string | undefined>,
}));
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// The real `createRepoPushTokenMinter` runs (so the unset-credentials 503 is real); only the GitHub
// adapter it constructs is stubbed.
vi.mock("@/adapters/server", () => ({
  GitHubVcsAdapter: class {
    mintRepoPushToken = mockMint;
  },
}));

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({ resolveNodeRepo: mockResolveNodeRepo }),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-11-18T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization: authzHolder.current,
  }),
  resolveServiceDb: () => ({}),
}));

vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: (_db: unknown, id: string) => dbState.byId[id] ?? null,
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

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "vcs.pushToken",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

vi.mock("@/shared/env", () => ({ serverEnv: () => envState.current }));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

import * as appHandler from "@/app/api/v1/vcs/push-token/route";

async function post(body: unknown, raw?: string): Promise<Response> {
  let res!: Response;
  await testApiHandler({
    appHandler,
    async test({ fetch }) {
      res = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw ?? JSON.stringify(body),
      });
    },
  });
  return res;
}

function grant(action: "node.push" | "node.flight", nodeId: string): void {
  authzHolder.current?.allow({
    actorId: `user:${TEST_SESSION_USER_1.id}`,
    action,
    resource: `node:${nodeId}`,
    context: { tenantId: nodeId, nodeId },
  });
}

function allLogs(): string {
  return JSON.stringify([
    mockLog.debug.mock.calls,
    mockLog.info.mock.calls,
    mockLog.warn.mock.calls,
    mockLog.error.mock.calls,
  ]);
}

describe("POST /api/v1/vcs/push-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzHolder.current = new FakeAuthorizationAdapter();
    for (const key of Object.keys(dbState.byId)) delete dbState.byId[key];
    for (const [nodeId, slug] of [
      [NODE_A, SLUG_A],
      [NODE_B, SLUG_B],
    ] as const) {
      dbState.byId[nodeId] = { nodeId, slug };
      dbState.byId[slug] = { nodeId, slug };
    }
    envState.current = {
      GH_NODE_DEV_APP_ID: "7",
      GH_NODE_DEV_APP_PRIVATE_KEY_BASE64:
        Buffer.from("private-key").toString("base64"),
      NODE_SUBMODULE_PARENT_OWNER: MONOREPO.owner,
      NODE_SUBMODULE_PARENT_REPO: MONOREPO.repo,
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mockResolveNodeRepo.mockImplementation(
      async ({ slug }: { slug: string }) => ({
        owner: "Cogni-DAO",
        repo: slug,
      })
    );
    mockMint.mockResolvedValue({
      token: TOKEN,
      expiresAt: "2026-11-18T01:00:00Z",
    });
  });

  it("returns 401 when unauthenticated, before any authz or mint", async () => {
    // Defect: an anonymous caller reaching the mint.
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("200: returns a one-repo token with the fixed permissions, uncached", async () => {
    // Defect: a widened permission set, a cached token response, or a repo other than the catalog's.
    grant("node.push", NODE_A);
    const res = await post({ nodeId: SLUG_A });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(pushTokenOperation.output.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      token: TOKEN,
      expiresAt: "2026-11-18T01:00:00Z",
      owner: "Cogni-DAO",
      repo: SLUG_A,
      permissions: PUSH_TOKEN_PERMISSIONS,
    });
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint).toHaveBeenCalledWith({ owner: "Cogni-DAO", repo: SLUG_A });
  });

  it("takes the repo from the catalog and ignores an owner/repo in the body", async () => {
    // Defect: an agent steering the mint to a repo of its choosing.
    grant("node.push", NODE_A);
    const res = await post({
      nodeId: SLUG_A,
      owner: "cogni-dao",
      repo: "node-template",
    });
    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith({ owner: "Cogni-DAO", repo: SLUG_A });
  });

  it("403 authz_denied without the pusher grant, and never mints", async () => {
    // Defect: deny-by-default lost, so any authenticated principal gets a push token.
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe("authz_denied");
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("403 for a developer (can_flight) who lacks can_push, and never mints", async () => {
    // Defect: `developer` implying `can_push`, which would force a node AI to hold merge/flight/attribution rights.
    grant("node.flight", NODE_A);
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("503 authz_unavailable when the authorizer is down (not a 403)", async () => {
    // Defect: an outage reading as a denial, or worse as an allow.
    authzHolder.current = null;
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(503);
    expect((await res.json()).errorCode).toBe("authz_unavailable");
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("403 when node A's principal asks for node B, before any repo is resolved or minted", async () => {
    // Defect: cross-node pollination, so one node's AI pushes to another node's repo.
    grant("node.push", NODE_A);
    const res = await post({ nodeId: SLUG_B });
    expect(res.status).toBe(403);
    expect(mockResolveNodeRepo).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
  });

  it.each([
    ["exact case", MONOREPO.owner, MONOREPO.repo],
    ["different case", "Cogni-Test-Org", "COGNI-Monorepo"],
  ])("403 in_repo_node_unsupported when the node resolves to the operator monorepo (%s)", async (_label, owner, repo) => {
    // Defect: the all-repos install covers the monorepo, so a missed case-insensitive compare would mint
    // a token that can push into the repo whose CI carries secrets.
    grant("node.push", NODE_A);
    mockResolveNodeRepo.mockResolvedValue({ owner, repo });
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe("in_repo_node_unsupported");
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("502 app_not_installed when the dev App is not installed on the node repo", async () => {
    // Defect: an opaque 500 that hides the one fix (install the App), or a retry loop on it.
    grant("node.push", NODE_A);
    mockMint.mockRejectedValue(
      new Error("GitHub App not installed on Cogni-DAO/creative (HTTP 404)")
    );
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(502);
    expect((await res.json()).errorCode).toBe("app_not_installed");
  });

  it("502 mint_failed, not app_not_installed, when the installation lookup is refused (bad key)", async () => {
    // Defect: a revoked or wrong App key reported as "not installed", sending the operator to the wrong fix.
    grant("node.push", NODE_A);
    mockMint.mockRejectedValueOnce(
      new Error("GitHub App not installed on Cogni-DAO/creative (HTTP 401)")
    );
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(502);
    expect((await res.json()).errorCode).toBe("mint_failed");
  });

  it.each([
    ["App id", { GH_NODE_DEV_APP_ID: undefined }],
    ["private key", { GH_NODE_DEV_APP_PRIVATE_KEY_BASE64: undefined }],
  ])("503 vcs_not_configured when the node dev App %s is unset", async (_l, unset) => {
    // Defect: falling back to the operator App's credentials, whose identity carries bypass rights.
    grant("node.push", NODE_A);
    envState.current = {
      ...envState.current,
      // The operator App's credentials are present: the route must still refuse rather than mint from them.
      GH_REVIEW_APP_ID: "99",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("operator-key").toString("base64"),
      ...unset,
    };
    const res = await post({ nodeId: SLUG_A });
    expect(res.status).toBe(503);
    expect((await res.json()).errorCode).toBe("vcs_not_configured");
    expect(mockMint).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", undefined, "{not json"],
    ["no nodeId", {}, undefined],
    ["empty nodeId", { nodeId: "" }, undefined],
  ])("400 validation_error on a malformed body (%s)", async (_l, body, raw) => {
    // Defect: a malformed body surfacing as a 500, or reaching authz and the mint.
    grant("node.push", NODE_A);
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("validation_error");
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("never logs the token, on success or when the mint error carries it", async () => {
    // Defect: a credential in logs, reachable by anyone who can read them.
    grant("node.push", NODE_A);
    expect((await post({ nodeId: SLUG_A })).status).toBe(200);

    mockMint.mockRejectedValue(new Error(`boom with ${TOKEN} inside`));
    const failed = await post({ nodeId: SLUG_A });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(TOKEN);

    expect(
      mockLog.info.mock.calls.length + mockLog.error.mock.calls.length
    ).toBeGreaterThan(0);
    expect(allLogs()).not.toContain(TOKEN);
    expect(allLogs()).not.toContain("ghs_");
  });
});
