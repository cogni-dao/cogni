// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  binding: vi.fn(),
  ask: vi.fn(),
  origin: "https://node.example" as string | undefined,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_lib/auth/request-identity", () => ({
  currentBearerToken: async () => null,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ APP_BASE_URL: mocks.origin }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BASE_URL: mocks.origin }),
}));
vi.mock("@/bootstrap/agent-tool-authority", () => ({
  getAgentToolAuthority: async () => ({
    listOwnAccess: mocks.list,
    requestAccess: mocks.ask,
  }),
  getAdminAiAccessCalls: mocks.binding,
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (ctx: unknown, request: Request, user: { id: string }) => unknown
    ) =>
    (request: Request) =>
      handler({ log: { error: vi.fn() } }, request, { id: "caller" }),
}));

import { POST as adminOn } from "@/app/api/v1/admin/ai-access/route";
import {
  POST as ask,
  GET as list,
} from "@/app/api/v1/agent/access-requests/route";

describe("access route boundaries", () => {
  beforeEach(() => vi.resetAllMocks());
  it("binds session listing to the authenticated user", async () => {
    mocks.list.mockResolvedValue([]);
    const response = await list(
      new Request("https://node.example/api/v1/agent/access-requests") as never
    );
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("caller");
  });
  it.each([
    undefined,
    "null",
    "https://other.example",
    "http://node.example",
    "https://node.example:444",
    "https://node.example/path",
  ])("refuses session writes with origin %s", async (origin) => {
    const response = await ask(
      new Request("https://node.example/api/v1/agent/access-requests", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: JSON.stringify({ scope: "work:read" }),
      }) as never
    );
    expect(response.status).toBe(403);
    expect(mocks.ask).not.toHaveBeenCalled();
  });
  it.each([
    "session",
    "bearer",
  ])("allows %s through the matching boundary", async (via) => {
    mocks.ask.mockResolvedValue({ created: true, state: "pending" });
    const response = await ask(
      new Request("https://node.example/api/v1/agent/access-requests", {
        method: "POST",
        headers:
          via === "session"
            ? { origin: "https://node.example" }
            : {
                authorization: "Bearer example",
                origin: "https://other.example",
              },
        body: JSON.stringify({ scope: "work:read" }),
      }) as never
    );
    expect(mocks.ask).toHaveBeenCalledWith({
      principalUserId: "caller",
      scope: "work:read",
    });
    expect(response.status).toBe(201);
  });
  it("fails closed when the configured origin is unavailable", async () => {
    mocks.origin = undefined;
    const response = await ask(
      new Request("https://node.example/api/v1/agent/access-requests", {
        method: "POST",
      }) as never
    );
    expect(response.status).toBe(503);
    expect(mocks.ask).not.toHaveBeenCalled();
    mocks.origin = "https://node.example";
  });
  it("binds bearer listing to the authenticated user", async () => {
    mocks.list.mockResolvedValue([]);
    const response = await list(
      new Request("https://node.example/api/v1/agent/access-requests", {
        headers: { authorization: "Bearer example" },
      }) as never
    );
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("caller");
  });
  it("refuses a non-admin before the shared write", async () => {
    mocks.binding.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
    });
    const response = await adminOn(
      new Request("https://node.example/api/v1/admin/ai-access", {
        method: "POST",
        headers: { origin: "https://node.example" },
        body: "{}",
      }) as never
    );
    expect(response.status).toBe(403);
    expect(mocks.binding).toHaveBeenCalledWith("caller");
  });
});
