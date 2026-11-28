// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  binding: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_lib/auth/request-identity", () => ({
  currentBearerToken: async () => null,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ APP_BASE_URL: "https://node.example" }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BASE_URL: "https://node.example" }),
}));
vi.mock("@/bootstrap/agent-tool-authority", () => ({
  getAgentToolAuthority: async () => ({ listOwnAccess: mocks.list }),
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
import { GET as list } from "@/app/api/v1/agent/access-requests/route";

describe("access route boundaries", () => {
  beforeEach(() => vi.resetAllMocks());
  it("refuses session access to the agent plane without reading grants", async () => {
    const response = await list(
      new Request("https://node.example/api/v1/agent/access-requests") as never
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.list).not.toHaveBeenCalled();
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
