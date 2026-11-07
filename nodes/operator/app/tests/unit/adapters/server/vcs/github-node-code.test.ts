// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-node-code`
 * Purpose: Prove immutable byte/range identity, path policy and honest absence with Git object fixtures.
 * Scope: Injected Git API and execution scope; no network, real credentials or model calls. Does not perform source mutations.
 * Invariants: Deny links before blob access; inaccessible/capped sources cannot prove absence.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027, story.5102 (review admission policy + code subject)
 * @internal
 */

import { createHash } from "node:crypto";
import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { describe, expect, it, vi } from "vitest";
import type { NodeCodeGitRequest } from "@/adapters/server/vcs/github-node-code.adapter";
import {
  admittedNodeCodePath,
  GitHubNodeCodeAdapter,
  isKeyMaterialFile,
  REVIEW_NODE_CODE_POLICY,
} from "@/adapters/server/vcs/github-node-code.adapter";
import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";
import { createNodeCodeCapability } from "@/bootstrap/capabilities/node-code";

const scope = vi.hoisted(
  () =>
    ({
      nodeId: "node-own",
      actorUserId: "developer",
      billing: { billingAccountId: "payer" },
    }) as {
      nodeId: string;
      actorUserId: string;
      billing: { billingAccountId: string };
      codeSubject?: {
        nodeId: string;
        owner: string;
        repo: string;
        baseSha: string;
        headSha: string;
      };
    }
);
const boundRead = vi.hoisted(() => vi.fn());
const readerFactory = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ read: boundRead, list: boundRead }))
);
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
vi.mock("@/adapters/server", async () => ({
  REVIEW_NODE_CODE_POLICY: (
    await import("@/adapters/server/vcs/github-node-code.adapter")
  ).REVIEW_NODE_CODE_POLICY,
  getExecutionScope: () => scope,
  GitHubVcsAdapter: class {
    nodeCodeReader(...args: unknown[]) {
      return readerFactory(...args);
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

  it("bound capability independently rechecks computed FGA authority before every source request", async () => {
    const authorization = new FakeAuthorizationAdapter();
    const request = {
      actorId: "user:developer",
      action: "node.flight" as const,
      resource: "node:node-own",
      context: { nodeId: "node-own", tenantId: "payer" },
    };
    const check = vi.spyOn(authorization, "check");
    const cap = createNodeCodeCapability({
      ...binding,
      appId: "123",
      privateKeyBase64: "aw==",
      log,
      getAuthorization: () => authorization,
    });
    scope.nodeId = "node-own";
    boundRead.mockClear();
    await expect(cap.read({ path: "packages/source.ts" })).rejects.toThrow(
      "authz_denied"
    );
    expect(check).toHaveBeenLastCalledWith(request);
    expect(boundRead).not.toHaveBeenCalled();
    authorization.allow(request);
    boundRead.mockResolvedValue({ complete: true });
    await cap.read({ path: "packages/source.ts" });
    expect(boundRead).toHaveBeenCalledTimes(1);
    authorization.deny(request);
    await expect(cap.list({ path: "packages" })).rejects.toThrow(
      "authz_denied"
    );
    expect(boundRead).toHaveBeenCalledTimes(1);
    authorization.unavailable(request);
    await expect(cap.read({ path: "packages/source.ts" })).rejects.toThrow(
      "authz_unavailable"
    );
    expect(boundRead).toHaveBeenCalledTimes(1);
    check.mockRejectedValueOnce(new Error("FGA offline"));
    await expect(cap.read({ path: "packages/source.ts" })).rejects.toThrow(
      "authz_unavailable"
    );
    expect(boundRead).toHaveBeenCalledTimes(1);
    const noAuthority = createNodeCodeCapability({
      ...binding,
      appId: "123",
      privateKeyBase64: "aw==",
      log,
    });
    await expect(
      noAuthority.read({ path: "packages/source.ts" })
    ).rejects.toThrow("authz_unavailable");
    expect(boundRead).toHaveBeenCalledTimes(1);
  });

  it("leaves optional private-code source unavailable when the host origin is missing or invalid", async () => {
    scope.nodeId = "node-own";
    boundRead.mockClear();
    for (const origin of [undefined, "invalid-origin"]) {
      const cap = createNodeCodeCapability({
        ...binding,
        origin,
        appId: "123",
        privateKeyBase64: "aw==",
        log,
      });
      await expect(cap.read({ path: "packages/source.ts" })).rejects.toThrow(
        "node_code_source_unavailable"
      );
    }
    expect(boundRead).not.toHaveBeenCalled();
  });

  it("host wrapper rejects a mismatched execution node and never falls back when source is unavailable", async () => {
    boundRead.mockClear();
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

  it("a code-subject run reads a NEW reader bound to the PR head with the review policy (story.5102)", async () => {
    const authorization = new FakeAuthorizationAdapter();
    authorization.allow({
      actorId: "user:developer",
      action: "node.flight",
      resource: "node:node-own",
      context: { nodeId: "node-own", tenantId: "payer" },
    });
    const head = "d".repeat(40);
    readerFactory.mockClear();
    boundRead.mockReset();
    boundRead.mockResolvedValue({ complete: true });
    const cap = createNodeCodeCapability({
      ...binding,
      appId: "123",
      privateKeyBase64: "aw==",
      log,
      getAuthorization: () => authorization,
    });
    // Construction built only the serving reader.
    expect(readerFactory).toHaveBeenCalledTimes(1);
    scope.nodeId = "node-own";
    scope.codeSubject = {
      nodeId: "node-own",
      owner: "test-org",
      repo: "pr-repo",
      baseSha: "e".repeat(40),
      headSha: head,
    };
    try {
      await cap.read({ path: ".github/workflows/ci.yml" });
      await cap.list({ path: "." });
      expect(readerFactory).toHaveBeenCalledTimes(3);
      for (const call of readerFactory.mock.calls.slice(1)) {
        expect(call[0]).toMatchObject({
          nodeId: "node-own",
          owner: "test-org",
          repo: "pr-repo",
          commitSha: head,
        });
        expect(call[2]).toBe(REVIEW_NODE_CODE_POLICY);
      }
      // v0 single-node authz: a subject for another node is denied before any read.
      scope.codeSubject = { ...scope.codeSubject, nodeId: "other-node" };
      boundRead.mockClear();
      await expect(cap.read({ path: "README.md" })).rejects.toThrow(
        "node_code_authz_denied"
      );
      expect(boundRead).not.toHaveBeenCalled();
    } finally {
      delete scope.codeSubject;
    }
  });
});

describe("review admission policy (story.5102)", () => {
  const head = "1".repeat(40);
  const rootTree = "2".repeat(40);
  const githubTree = "3".repeat(40);
  const workflowsTree = "4".repeat(40);
  const scriptsTree = "5".repeat(40);
  const text = "name: ci\non: push\n";
  const textBytes = Buffer.from(text, "utf8");
  const textBlob = createHash("sha1")
    .update(`blob ${textBytes.length}\0`)
    .update(textBytes)
    .digest("hex");
  const reviewBinding = {
    nodeId: "node-own",
    origin: "https://node.example",
    owner: "test-org",
    repo: "pr-repo",
    commitSha: head,
    roots: [],
    manifests: [],
  };
  const file = (path: string) => ({
    path,
    mode: path.endsWith(".sh") ? "100755" : "100644",
    type: "blob",
    sha: textBlob,
    size: textBytes.length,
  });
  const dir = (path: string, sha: string) => ({
    path,
    mode: "040000",
    type: "tree",
    sha,
  });
  const trees: Record<string, unknown[]> = {
    [rootTree]: [
      dir(".github", githubTree),
      dir("scripts", scriptsTree),
      dir(".git", "6".repeat(40)),
      file(".env"),
      file(".env.example"),
      file(".env.production"),
      file("server.pem"),
      file("id_rsa"),
    ],
    [githubTree]: [dir("workflows", workflowsTree)],
    [workflowsTree]: [file("x.yml")],
    [scriptsTree]: [file("deploy.sh")],
  };
  const requested: string[] = [];
  const request: NodeCodeGitRequest = async (route, params) => {
    expect(params).toMatchObject({ owner: "test-org", repo: "pr-repo" });
    if (route.includes("commits")) {
      requested.push(`commit:${params.commit_sha}`);
      return { sha: head, tree: { sha: rootTree } };
    }
    if (route.includes("trees")) {
      const sha = params.tree_sha ?? "";
      return { sha, truncated: false, tree: trees[sha] ?? [] };
    }
    requested.push(`blob:${params.file_sha}`);
    return {
      sha: textBlob,
      encoding: "base64",
      size: textBytes.length,
      content: textBytes.toString("base64"),
    };
  };
  const reader = new GitHubNodeCodeAdapter(
    reviewBinding,
    request,
    log,
    REVIEW_NODE_CODE_POLICY
  );

  it("reads .github/workflows/x.yml and a .sh at the PR head", async () => {
    for (const path of [".github/workflows/x.yml", "scripts/deploy.sh"]) {
      const result = await reader.read({ path });
      expect(result).toMatchObject({
        complete: true,
        exists: true,
        content: text,
        commitSha: head,
        repo: "test-org/pr-repo",
      });
    }
    expect(requested).toContain(`commit:${head}`);
  });

  it("reads .env.example but refuses .env, .env.* and key material, naming the path", async () => {
    expect(await reader.read({ path: ".env.example" })).toMatchObject({
      exists: true,
      content: text,
    });
    for (const path of [
      ".env",
      ".env.production",
      "server.pem",
      "id_rsa",
      "certs/tls.key",
      "keys/store.p12",
      ".git/config",
      "../escape.ts",
    ]) {
      expect(await reader.read({ path })).toMatchObject({
        path,
        content: null,
        reason: "node_code_path_denied",
      });
    }
  });

  // KEY_MATERIAL_IS_ONE_LIST: every name below is refused by the review policy AND the serving
  // policy (case-insensitive), because both are built on the same key-material list.
  it.each([
    "id_rsa",
    "id_rsa.pub",
    "id_dsa",
    "id_dsa.pub",
    "id_ecdsa",
    "id_ecdsa.pub",
    "id_ed25519",
    "id_ed25519.pub",
    "ID_ED25519",
    "server.pem",
    "SERVER.PEM",
    "tls.key",
    "store.p12",
    "store.pfx",
    "app.jks",
    "release.keystore",
    "terraform.tfstate",
    "prod.tfvars",
    ".envrc",
    ".npmrc",
    ".netrc",
    "credentials.json",
    ".env",
    ".ENV",
    ".env.local",
    ".env.production",
  ])("refuses key material %s in both policies", async (name) => {
    expect(isKeyMaterialFile(name)).toBe(true);
    expect(REVIEW_NODE_CODE_POLICY.admits(`config/${name}`, false)).toBe(false);
    expect(
      admittedNodeCodePath(
        { roots: ["packages"], manifests: [] },
        `packages/${name}`
      )
    ).toBe(false);
    expect(await reader.read({ path: `config/${name}` })).toMatchObject({
      content: null,
      reason: "node_code_path_denied",
    });
  });

  it.each([
    ".env.example",
    ".ENV.EXAMPLE",
    "id_rsa_rotation.ts",
    "keys.ts",
    "credentials-schema.ts",
  ])("the review policy still reads %s", (name) => {
    expect(isKeyMaterialFile(name)).toBe(false);
    expect(REVIEW_NODE_CODE_POLICY.admits(`src/${name}`, false)).toBe(true);
  });

  it("lists every top-level root and dot-dir except .git, omitting secret files", async () => {
    const listing = await reader.list({ path: "." });
    expect(listing.entries.map((e) => e.path).sort()).toEqual([
      ".env.example",
      ".github",
      "scripts",
    ]);
  });
});
