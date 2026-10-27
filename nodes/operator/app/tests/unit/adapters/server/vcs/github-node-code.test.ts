// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-node-code`
 * Purpose: Prove immutable byte/range identity, path policy and honest absence with Git object fixtures.
 * Scope: Injected Git API and execution scope; no network, real credentials or model calls.
 * Invariants: Deny links before blob access; inaccessible/capped sources cannot prove absence.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027
 * @internal
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NodeCodeGitRequest } from "@/adapters/server/vcs/github-node-code.adapter";
import { GitHubNodeCodeAdapter } from "@/adapters/server/vcs/github-node-code.adapter";
import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";
import { createNodeCodeCapability } from "@/bootstrap/capabilities/node-code";

const scope = vi.hoisted(() => ({
  nodeId: "node-own",
  actorUserId: "developer",
}));
const boundRead = vi.hoisted(() => vi.fn());
const authCalls = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({ token: "synthetic-test-token" }))
);
const apiCalls = vi.hoisted(() =>
  vi.fn(
    async (_route: string, _params: unknown): Promise<{ data: unknown }> => ({
      data: null,
    })
  )
);
vi.mock("@octokit/auth-app", () => ({ createAppAuth: () => authCalls }));
vi.mock("@octokit/core", () => ({
  Octokit: class {
    request = apiCalls;
  },
}));
vi.mock("@/adapters/server/ai/execution-scope", () => ({
  getExecutionScope: () => scope,
}));
vi.mock("@/adapters/server", () => ({
  GitHubVcsAdapter: class {
    nodeCodeReader() {
      return { read: boundRead, list: boundRead };
    }
  },
}));

const commit = "a".repeat(40);
const treeRoot = "b".repeat(40);
const treePackages = "c".repeat(40);
const body = "\uFEFFfirst\r\nsecond 🧭\nlast\n";
const bytes = Buffer.from(body, "utf8");
const blob = createHash("sha1")
  .update(`blob ${bytes.length}\0`)
  .update(bytes)
  .digest("hex");
const binding = {
  nodeId: "node-own",
  origin: "https://node.example",
  owner: "org",
  repo: "node",
  commitSha: commit,
  roots: ["packages"],
  manifests: ["package.json"],
};
const log = { info: vi.fn(), warn: vi.fn() };
function fixture(
  options: {
    mode?: string;
    missing?: boolean;
    truncated?: boolean;
    oversize?: boolean;
    mismatch?: boolean;
    fault?: number;
  } = {}
) {
  const calls: string[] = [];
  const request: NodeCodeGitRequest = async (route, params, signal) => {
    calls.push(route);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(params).toMatchObject({ owner: "org", repo: "node" });
    if (options.fault)
      throw Object.assign(new Error("inaccessible"), { status: options.fault });
    if (route.includes("commits")) {
      expect(params.commit_sha).toBe(commit);
      return {
        sha: options.mismatch ? "f".repeat(40) : commit,
        tree: { sha: treeRoot },
      };
    }
    if (route.includes("trees")) {
      if (params.tree_sha === treeRoot)
        return {
          sha: treeRoot,
          truncated: false,
          tree: [
            {
              path: "packages",
              mode: "040000",
              type: "tree",
              sha: treePackages,
            },
          ],
        };
      expect(params.tree_sha).toBe(treePackages);
      return {
        sha: treePackages,
        truncated: options.truncated ?? false,
        tree: options.missing
          ? []
          : [
              {
                path: "source.ts",
                mode: options.mode ?? "100644",
                type: options.mode === "160000" ? "commit" : "blob",
                sha: blob,
                size: options.oversize ? 999999 : bytes.length,
              },
              {
                path: ".env",
                mode: "100644",
                type: "blob",
                sha: blob,
                size: 7,
              },
            ],
      };
    }
    expect(route).toContain("blobs");
    expect(params.file_sha).toBe(blob);
    return {
      sha: blob,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    };
  };
  return { reader: new GitHubNodeCodeAdapter(binding, request, log), calls };
}

describe("host-bound immutable node Git reader", () => {
  it("reuses App installation auth with repository-limited contents:read and pinned API requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 123 }), { status: 200 })
      );
    apiCalls.mockImplementation(async (route, params) => {
      expect(params).toMatchObject({
        owner: "org",
        repo: "node",
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
        request: { signal: expect.any(AbortSignal) },
      });
      if (route.includes("commits"))
        return { data: { sha: commit, tree: { sha: treeRoot } } };
      return { data: { sha: treeRoot, truncated: false, tree: [] } };
    });
    try {
      const vcs = new GitHubVcsAdapter({
        appId: "123",
        privateKey: "synthetic-key",
      });
      const result = await vcs.nodeCodeReader(binding, log).list({ path: "." });
      expect(result).toMatchObject({
        complete: true,
        exists: true,
        entries: [],
      });
      expect(authCalls).toHaveBeenCalledWith({
        type: "installation",
        installationId: 123,
        repositoryNames: ["node"],
        permissions: { contents: "read" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/org/node/installation",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(
        apiCalls.mock.calls.every(
          ([route]) => route.startsWith("GET ") && !route.includes("contents")
        )
      ).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("returns exact UTF8 range bytes, their hash and full commit/path/line provenance", async () => {
    const { reader } = fixture();
    const result = await reader.read({
      path: "packages/source.ts",
      lineStart: 2,
      lineEnd: 2,
    });
    expect(result).toMatchObject({
      nodeId: "node-own",
      origin: "https://node.example",
      repo: "org/node",
      commitSha: commit,
      path: "packages/source.ts",
      complete: true,
      exists: true,
      fileComplete: false,
      lineStart: 2,
      lineEnd: 2,
      totalLines: 3,
      content: "second 🧭\n",
      sha256: createHash("sha256").update("second 🧭\n").digest("hex"),
      citation: `https://github.com/org/node/blob/${commit}/packages/source.ts#L2-L2`,
    });
    expect(await reader.read({ path: "packages/source.ts" })).toMatchObject({
      content: body,
      fileComplete: true,
    });
  });

  it("denies secret paths, traversal, dot paths and non-source paths before any transport", async () => {
    const { reader, calls } = fixture();
    for (const path of [
      "../packages/source.ts",
      "packages/../source.ts",
      "packages/.env",
      "packages/credentials.ts",
      "packages/key.pem",
      "packages/.git/config",
      "packages/%2e%2e/source.ts",
      "packages\\source.ts",
      "/packages/source.ts",
      "infra/runtime.yaml",
      "packages/source.png",
    ]) {
      expect(await reader.read({ path })).toMatchObject({
        complete: false,
        exists: null,
        reason: "node_code_path_denied",
      });
    }
    expect(calls).toEqual([]);
  });

  it.each([
    "120000",
    "160000",
  ])("rejects mode %s before any blob/Contents request", async (mode) => {
    const { reader, calls } = fixture({ mode });
    expect(await reader.read({ path: "packages/source.ts" })).toMatchObject({
      complete: false,
      exists: null,
      reason: "node_code_link_denied",
    });
    expect(
      calls.some((c) => c.includes("blobs") || c.includes("contents"))
    ).toBe(false);
    expect(await reader.list({ path: "packages" })).toMatchObject({
      complete: false,
      exists: null,
      entries: [],
      reason: "node_code_listing_incomplete",
    });
  });

  it("proves absence only from an accessible immutable commit and complete parent tree", async () => {
    const { reader } = fixture({ missing: true });
    expect(await reader.read({ path: "packages/new.ts" })).toMatchObject({
      complete: true,
      exists: false,
      content: null,
      reason: "node_code_path_absent",
    });
    for (const options of [
      { fault: 404 },
      { fault: 403 },
      { truncated: true },
      { mismatch: true },
    ]) {
      expect(
        await fixture(options).reader.read({ path: "packages/new.ts" })
      ).toMatchObject({ complete: false, exists: null });
    }
  });

  it("reports incomplete bounded evidence and lists admitted direct children only", async () => {
    expect(
      await fixture({ oversize: true }).reader.read({
        path: "packages/source.ts",
      })
    ).toMatchObject({
      complete: false,
      exists: null,
      reason: "node_code_file_incomplete",
    });
    expect(
      await fixture().reader.read({
        path: "packages/source.ts",
        lineStart: 1,
        lineEnd: 201,
      })
    ).toMatchObject({ complete: false, reason: "node_code_range_denied" });
    expect(
      await fixture({ truncated: true }).reader.list({ path: "packages" })
    ).toMatchObject({ complete: false, exists: null, entries: [] });
    expect(await fixture().reader.list({ path: "packages" })).toMatchObject({
      complete: true,
      exists: true,
      entries: [{ path: "packages/source.ts", type: "file", sha: blob }],
    });
    expect(await fixture().reader.list({ path: "." })).toMatchObject({
      complete: true,
      exists: true,
      entries: [{ path: "packages", type: "directory", sha: treePackages }],
    });
  });

  it("host wrapper rejects a mismatched execution node and never falls back when source is unavailable", async () => {
    const cap = createNodeCodeCapability({
      ...binding,
      appId: "123",
      privateKeyBase64: "aw==",
      log,
    });
    scope.nodeId = "foreign-node";
    await expect(cap.read({ path: "packages/source.ts" })).rejects.toThrow(
      "node_code_scope_unavailable"
    );
    expect(boundRead).not.toHaveBeenCalled();
    scope.nodeId = "node-own";
    const unavailable = createNodeCodeCapability({
      ...binding,
      appId: undefined,
      privateKeyBase64: undefined,
      log,
    });
    await expect(
      unavailable.read({ path: "packages/source.ts" })
    ).rejects.toThrow("node_code_source_unavailable");
    expect(boundRead).not.toHaveBeenCalled();
  });
});
