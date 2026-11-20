// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-vcs-push-token`
 * Purpose: Prove a push token is minted for exactly one repo with exactly contents + pull_requests write.
 * Scope: Mocked auth-app and fetch; no network or real credentials.
 * Invariants: FIXED_PERMISSIONS — a widened token (workflows, administration, extra repos) fails this test.
 * Side-effects: none
 * Links: nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";

const authCalls = vi.hoisted(() =>
  vi.fn(async (input: { type: string }) =>
    input.type === "app"
      ? { token: "app-jwt" }
      : { token: "ghs_synthetic", expiresAt: "2026-11-18T23:00:00Z" }
  )
);
vi.mock("@octokit/auth-app", () => ({ createAppAuth: () => authCalls }));

afterEach(() => {
  vi.unstubAllGlobals();
  authCalls.mockClear();
});

describe("GitHubVcsAdapter.mintRepoPushToken", () => {
  it("requests one repo with only contents and pull_requests write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ id: 42 }), { status: 200 })
      )
    );
    const adapter = new GitHubVcsAdapter({ appId: "1", privateKey: "k" });

    const minted = await adapter.mintRepoPushToken({
      owner: "cogni-dao",
      repo: "node-template",
    });

    expect(minted).toEqual({
      token: "ghs_synthetic",
      expiresAt: "2026-11-18T23:00:00Z",
    });
    expect(authCalls).toHaveBeenCalledWith({
      type: "installation",
      installationId: 42,
      repositoryNames: ["node-template"],
      permissions: { contents: "write", pull_requests: "write" },
      refresh: true,
    });
  });

  it("fails when the App is not installed on the repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 }))
    );
    const adapter = new GitHubVcsAdapter({ appId: "1", privateKey: "k" });

    await expect(
      adapter.mintRepoPushToken({ owner: "cogni-dao", repo: "missing" })
    ).rejects.toThrow("GitHub App not installed on cogni-dao/missing");
  });
});
