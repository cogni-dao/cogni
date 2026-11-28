// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  session: vi.fn(),
  binding: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dismiss: vi.fn(),
  everConfirmed: vi.fn(),
  base: "https://node.example/app",
}));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: mocks.session }));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({
    AUTH_SECRET: "unit-test-only-secret",
    APP_BASE_URL: mocks.base,
  }),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => ({ everConfirmed: mocks.everConfirmed }),
}));
vi.mock("@/bootstrap/agent-tool-authority", () => ({
  getAdminAiAccessCalls: mocks.binding,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    config: { unhandledErrorPolicy: "rethrow" },
    log: {},
    clock: {},
  }),
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: (
    _name: unknown,
    _attrs: unknown,
    run: (ctx: unknown) => unknown
  ) => run({ traceId: "test", span: { setAttribute: vi.fn() } }),
}));
vi.mock("@/shared/observability", () => ({
  createRequestContext: () => ({
    reqId: "test",
    log: { error: vi.fn(), warn: vi.fn() },
  }),
  EVENT_NAMES: {},
  httpRequestDurationMs: { observe: vi.fn() },
  httpRequestsTotal: { inc: vi.fn() },
  logRequestEnd: vi.fn(),
  logRequestError: vi.fn(),
  logRequestStart: vi.fn(),
  statusBucket: () => "2xx",
}));

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { DELETE, POST } from "@/app/api/v1/admin/ai-access/route";

async function invoke(
  method: "POST" | "DELETE",
  origin?: string,
  authorization?: string,
  deny = false
) {
  const headers = new Headers({
    "content-type": "application/json",
    host: "node.example",
  });
  if (origin !== undefined) headers.set("origin", origin);
  if (authorization) headers.set("authorization", authorization);
  mocks.headers = headers;
  const request = new Request("https://node.example/api/v1/admin/ai-access", {
    method,
    headers,
    body: JSON.stringify({
      principal: "helper",
      scope: "work.read",
      ...(deny ? { deny: true } : {}),
    }),
  });
  return (method === "POST" ? POST : DELETE)(request as never);
}
describe("admin access origin boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.base = "https://node.example/app";
    mocks.session.mockResolvedValue({
      id: "session-user",
      walletAddress: null,
      displayName: null,
      avatarColor: null,
    });
    mocks.everConfirmed.mockResolvedValue(false);
    mocks.binding.mockResolvedValue({
      ok: true,
      calls: { on: mocks.on, off: mocks.off, dismiss: mocks.dismiss },
    });
    mocks.on.mockResolvedValue({
      changed: true,
      principalUserId: "agent-target",
    });
    mocks.off.mockResolvedValue({
      changed: true,
      principalUserId: "agent-target",
    });
    mocks.dismiss.mockResolvedValue({
      changed: true,
      principalUserId: "agent-target",
    });
  });
  it.each([
    undefined,
    "null",
    "garbage",
    "https://evil.example",
    "http://node.example",
    "https://node.example/path",
    "https://user@node.example",
  ])("rejects session origin %s before binding", async (origin) => {
    for (const [method, deny] of [
      ["POST", false],
      ["DELETE", false],
      ["DELETE", true],
    ] as const) {
      const response = await invoke(method, origin, undefined, deny);
      expect([401, 403]).toContain(response.status);
      expect(mocks.binding).not.toHaveBeenCalled();
      expect(mocks.on).not.toHaveBeenCalled();
      expect(mocks.off).not.toHaveBeenCalled();
      expect(mocks.dismiss).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["POST", false, "on"],
    ["DELETE", false, "off"],
    ["DELETE", true, "dismiss"],
  ] as const)("allows canonical session %s %s", async (method, deny, operation) => {
    const response = await invoke(
      method,
      "https://node.example",
      undefined,
      deny
    );
    expect(response.status).toBe(200);
    expect(mocks.binding).toHaveBeenCalledWith("session-user");
    expect(mocks[operation]).toHaveBeenCalledOnce();
  });
  it("refuses missing canonical configuration", async () => {
    mocks.base = "";
    expect((await invoke("POST", "https://node.example")).status).toBe(403);
    expect(mocks.binding).not.toHaveBeenCalled();
  });
  it("allows a verified bearer without Origin and excludes the session", async () => {
    const token = issueAgentApiKey({ userId: "agent", displayName: null });
    expect((await invoke("POST", undefined, `Bearer ${token}`)).status).toBe(
      200
    );
    expect(mocks.binding).toHaveBeenCalledWith("agent");
    expect(mocks.on).toHaveBeenCalledOnce();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("refuses invalid bearer even with an eligible session and origin", async () => {
    expect(
      (await invoke("POST", "https://node.example", "Bearer invalid")).status
    ).toBe(401);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.binding).not.toHaveBeenCalled();
  });
});
