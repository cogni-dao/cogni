// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { AgentAuthoritySql } from "@cogni-dao/agent-grants/host";
import { describe, expect, it, vi } from "vitest";

import AdminLayout from "@/app/(admin)/layout";
import * as authorityModule from "@/bootstrap/agent-tool-authority";

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ({ id: "oauth-user", walletAddress: null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/app/(admin)/AdminShell", () => ({ AdminShell: () => null }));

describe("admin page and API authority parity", () => {
  it("admits an OAuth session through the same bound-wallet decision as the API", async () => {
    const sql = Object.assign(
      vi.fn(async () => [{ external_id: "dao-wallet" }]),
      { begin: vi.fn() }
    );
    const host = authorityModule.createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      isAdminWallet: (wallet) => wallet === "dao-wallet",
      log: { info() {}, warn() {}, error() {} },
    });
    const bind = (userId: string) =>
      authorityModule.bindAdminAiAccessCalls(host, userId);
    const spy = vi
      .spyOn(authorityModule, "getAdminAiAccessCalls")
      .mockImplementation(bind);
    expect((await bind("oauth-user")).ok).toBe(true);
    await expect(AdminLayout({ children: "content" })).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalledWith("oauth-user");
    spy.mockRestore();
  });

  it("redirects denied users and surfaces unavailable authority", async () => {
    const spy = vi.spyOn(authorityModule, "getAdminAiAccessCalls");
    spy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
    });
    await expect(AdminLayout({ children: "content" })).rejects.toThrow(
      "redirect:/dashboard"
    );
    spy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      reason: "test",
    });
    await expect(AdminLayout({ children: "content" })).rejects.toThrow(
      "admin authority unavailable"
    );
    spy.mockRestore();
  });
});
