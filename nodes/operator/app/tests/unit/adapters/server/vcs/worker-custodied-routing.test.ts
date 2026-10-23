// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/unit/adapters/server/vcs/worker-custodied-routing`
 * Purpose: Exercise actual deploy adapter service transactions and promotion preservation.
 * Scope: Mocked native GitHub API; hermetic Python guard calls with local generated fixtures.
 * Invariants: Fixed production ownership, one-field CAS, verified rollback, selection durability.
 * Side-effects: Local subprocess reads only; no remote IO.
 * Links: spike.5010
 * @internal
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));
vi.mock("@octokit/core", () => ({
  Octokit: class {
    request = mock.request;
  },
}));

import { GitHubRepoWriter } from "@/adapters/server/vcs/github-repo-write";
import {
  addApprovedCandidate,
  candidateAliases,
  WORKER_ROUTING_PATH as FILE,
  WORKER_ROUTING_REF as REF,
  readWorkerPatch,
  selectCandidate,
  WORKER_ROUTING_TARGET as TARGET,
} from "@/adapters/server/vcs/worker-custodied-routing";

const ROOT = path.resolve(import.meta.dirname, "../../../../../../../..");
const AUTH = "a".repeat(40),
  HEAD = "b".repeat(40),
  PUB = "c".repeat(40),
  OTHER = "d".repeat(40);
const input = {
  env: "production",
  slug: "operator",
  parentOwner: "configured-owner",
  parentRepo: "configured-repo",
  target: TARGET,
} as const;
const config = {
  appId: "123",
  privateKey: "fake",
  hostingEnv: "production",
  fleetControlEnv: "production",
  parentOwner: input.parentOwner,
  parentRepo: input.parentRepo,
};
const canonical = readFileSync(path.join(ROOT, FILE), "utf8");
const all = readWorkerPatch(canonical).selected ?? "";
const old = all
  .split(",")
  .filter(
    (p) =>
      !p.startsWith("toks5=") &&
      !p.startsWith("f66b260b-") &&
      !p.startsWith("node-template=") &&
      !p.startsWith("b927a9dd-")
  )
  .join(",");
const original = selectCandidate(canonical, old);
const sha = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");
const contents = (text: string) => ({
  type: "file",
  sha: sha(text),
  encoding: "base64",
  content: Buffer.from(text).toString("base64"),
});
let live: string,
  head: string,
  messages: Map<string, string>,
  texts: Map<string, string>,
  commits: Map<string, Record<string, unknown>>;
function writer(overrides: Partial<typeof config> = {}) {
  return new GitHubRepoWriter({ ...config, ...overrides });
}
function signedCommit(message: string) {
  return {
    sha: PUB,
    parents: [{ sha: HEAD }],
    author: { login: "operator-app[bot]", id: 789, type: "Bot" },
    committer: { login: "web-flow", id: 19864447 },
    commit: {
      message,
      committer: { name: "GitHub", email: "noreply@github.com" },
      verification: { verified: true, reason: "valid" },
    },
    files: [{ filename: FILE, status: "modified" }],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/app") ? { slug: "operator-app" } : { id: 456 },
    }))
  );
  live = original;
  head = HEAD;
  messages = new Map();
  texts = new Map([
    [AUTH, canonical],
    [HEAD, original],
  ]);
  commits = new Map();
  mock.request.mockImplementation(
    async (route: string, p: Record<string, unknown>) => {
      if (route.includes("/branches/"))
        return { data: { protected: true, commit: { sha: AUTH } } };
      if (route.includes("/git/ref/"))
        return { data: { object: { sha: head } } };
      if (route === "GET /users/{username}") return { data: { id: 789 } };
      if (route === "GET /installation")
        return { data: { app_id: 123, app_slug: "operator-app" } };
      if (route.includes("/compare/")) return { data: { status: "ahead" } };
      if (route.includes("/commits/"))
        return { data: commits.get(String(p.ref)) };
      if (route.startsWith("GET ") && route.includes("/contents/")) {
        expect(p.path).toBe(FILE);
        expect(p.ref).not.toBe("main");
        expect(p.ref).not.toBe(REF);
        const text = texts.get(String(p.ref));
        if (!text) throw new Error(`unhandled ref ${p.ref}`);
        return { data: contents(text) };
      }
      if (route.startsWith("PUT ")) {
        expect(p.owner).toBe(input.parentOwner);
        expect(p.repo).toBe(input.parentRepo);
        expect(p.path).toBe(FILE);
        expect(p.branch).toBe(REF);
        expect(p.sha).toBe(sha(live));
        live = Buffer.from(String(p.content), "base64").toString("utf8");
        head = PUB;
        texts.set(PUB, live);
        messages.set(PUB, String(p.message));
        commits.set(PUB, signedCommit(String(p.message)));
        return { data: { commit: { sha: PUB }, content: { sha: sha(live) } } };
      }
      throw new Error(`unhandled ${route}`);
    }
  );
});

describe("fixed worker service adapter", () => {
  it("publishes both actual added nodes, retains all other bytes, and returns Git evidence", async () => {
    const result = await writer().reconcileNodeInfra(input);
    expect(result).toMatchObject({
      status: "git_published",
      authoritySha: AUTH,
      deploySha: PUB,
      receipt: PUB,
      beforeBlob: sha(original),
      afterBlob: sha(live),
      deployRef: REF,
    });
    const selected = readWorkerPatch(live).selected ?? "";
    expect(selected).toContain("toks5=https://toks5-test.cognidao.org");
    expect(selected).toContain(
      "node-template=https://node-template-test.cognidao.org"
    );
    expect(selectCandidate(live, old)).toBe(original);
    expect(
      mock.request.mock.calls.filter(([r]) => r.includes("/branches/"))
    ).toHaveLength(1);
    expect(await writer().reconcileNodeInfra(input)).toMatchObject({
      status: "unchanged",
      receipt: null,
      deploySha: PUB,
    });
  });
  it.each([
    { hostingEnv: "candidate-a" },
    { fleetControlEnv: "candidate-a" },
    { hostingEnv: undefined },
    { fleetControlEnv: undefined },
    { parentRepo: "different" },
    { parentOwner: undefined },
  ])("denies ownership mismatch before App/repo IO: %j", async (override) => {
    await expect(
      writer(override as Partial<typeof config>).reconcileNodeInfra(input)
    ).rejects.toThrow("own-custodian");
    expect(mock.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("strictly denies source/ref/payload on direct adapter invocation", async () => {
    await expect(
      writer().reconcileNodeInfra({ ...input, sourceSha: AUTH } as typeof input)
    ).rejects.toThrow();
    expect(mock.request).not.toHaveBeenCalled();
  });
  it("denies unprotected main without reading its tree", async () => {
    mock.request.mockResolvedValueOnce({
      data: { protected: false, commit: { sha: AUTH } },
    });
    await expect(writer().reconcileNodeInfra(input)).rejects.toThrow();
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it("retries a file CAS with a fresh immutable current read and retains unrelated drift", async () => {
    const delegate = mock.request.getMockImplementation();
    let rejected = false;
    mock.request.mockImplementation(
      async (route: string, p: Record<string, unknown>) => {
        if (route.startsWith("PUT ") && !rejected) {
          rejected = true;
          live = `${original}# concurrent unrelated edit\n`;
          head = OTHER;
          texts.set(OTHER, live);
          throw Object.assign(new Error("CAS"), { status: 409 });
        }
        return delegate?.(route, p);
      }
    );
    await expect(writer().reconcileNodeInfra(input)).resolves.toMatchObject({
      status: "git_published",
    });
    expect(live).toContain("# concurrent unrelated edit");
    expect(
      mock.request.mock.calls.filter(([r]) => r.startsWith("PUT "))
    ).toHaveLength(2);
  });
  it("bounds CAS conflicts to three attempts", async () => {
    const delegate = mock.request.getMockImplementation();
    mock.request.mockImplementation((r: string, p: Record<string, unknown>) =>
      r.startsWith("PUT ")
        ? Promise.reject(Object.assign(new Error("CAS"), { status: 409 }))
        : delegate?.(r, p)
    );
    await expect(writer().reconcileNodeInfra(input)).rejects.toThrow("CAS");
    expect(
      mock.request.mock.calls.filter(([r]) => r.startsWith("PUT "))
    ).toHaveLength(3);
  });
  it("rolls back the receipt candidate only, preserving later namespace and comment changes", async () => {
    await writer().reconcileNodeInfra(input);
    live = `${live.replace(
      '"cogni-preview":',
      '"cogni-extra":"preserve exact", "cogni-preview":'
    )}# later image/source namespace changes\n`;
    head = OTHER;
    texts.set(OTHER, live);
    const current = live;
    const result = await writer().reconcileNodeInfra({
      ...input,
      rollbackReceipt: PUB,
    });
    expect(result).toMatchObject({ status: "git_published", receipt: null });
    expect(live).toBe(selectCandidate(current, old));
  });
  it("refuses rollback after candidate drift", async () => {
    await writer().reconcileNodeInfra(input);
    head = OTHER;
    live = selectCandidate(live, old);
    texts.set(OTHER, live);
    await expect(
      writer().reconcileNodeInfra({ ...input, rollbackReceipt: PUB })
    ).rejects.toThrow("drifted");
  });
  it.each([
    "signature",
    "actor",
    "committer",
    "signer",
    "files",
    "parent",
    "blob",
    "trailer",
    "authority",
    "history",
  ])("refuses forged/incompatible receipt: %s", async (kind) => {
    await writer().reconcileNodeInfra(input);
    const commit = commits.get(PUB) as ReturnType<typeof signedCommit>;
    if (kind === "signature") commit.commit.verification.verified = false;
    if (kind === "actor") commit.author.id = 12345;
    if (kind === "committer") commit.committer.id = 12345;
    if (kind === "signer")
      commit.commit.committer.email = "other@example.invalid";
    if (kind === "files")
      commit.files.push({ filename: FILE, status: "modified" });
    if (kind === "parent") commit.parents.push({ sha: OTHER });
    if (kind === "blob")
      commit.commit.message = commit.commit.message.replace(
        sha(original),
        "e".repeat(40)
      );
    if (kind === "trailer")
      commit.commit.message += "\nCogni-Worker-Routing-v1: {}";
    if (kind === "authority" || kind === "history") {
      const delegate = mock.request.getMockImplementation();
      mock.request.mockImplementation(
        (r: string, p: Record<string, unknown>) =>
          r.includes("/compare/") &&
          String(p.basehead).startsWith(kind === "history" ? PUB : AUTH)
            ? { data: { status: "diverged" } }
            : delegate?.(r, p)
      );
    }
    const puts = mock.request.mock.calls.filter(([r]) =>
      r.startsWith("PUT ")
    ).length;
    await expect(
      writer().reconcileNodeInfra({ ...input, rollbackReceipt: PUB })
    ).rejects.toThrow();
    expect(
      mock.request.mock.calls.filter(([r]) => r.startsWith("PUT "))
    ).toHaveLength(puts);
  });
});

describe("canonical pair validation and promotion selection", () => {
  it.each([
    "slug=https://host",
    "slug=https://a,slug=https://a",
    "slug=https://a,12345678-1234-4123-8123-123456789012=https://b",
    "slug=https://user:pass@a,12345678-1234-4123-8123-123456789012=https://user:pass@a",
    "slug=https://a/path,12345678-1234-4123-8123-123456789012=https://a/path",
  ])("denies invalid identity/address pair: %s", (csv) =>
    expect(() => candidateAliases(csv)).toThrow());
  it("denies duplicate namespaces, duplicate YAML keys and wrong resource identity", () => {
    expect(() =>
      readWorkerPatch(
        canonical.replace(
          '"cogni-preview":',
          '"cogni-candidate-a":"", "cogni-preview":'
        )
      )
    ).toThrow();
    expect(() => readWorkerPatch(`${canonical}kind: ConfigMap\n`)).toThrow();
    expect(() =>
      readWorkerPatch(
        canonical.replace("name: scheduler-worker-config", "name: other")
      )
    ).toThrow();
  });
  it("denies an alias repoint", () =>
    expect(() =>
      addApprovedCandidate(
        original.replaceAll(
          "https://poly-test.cognidao.org",
          "https://wrong.example"
        ),
        canonical
      )
    ).toThrow());
  it("preserves current selection across a stale image tree and preserves rollback subsets", () => {
    const script = path.join(
      ROOT,
      "scripts/ci/lib/worker-routing-preservation.py"
    );
    const run = (current: string, authority: string, copied: string) =>
      execFileSync(
        "python3",
        [
          "-c",
          "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('guard',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.preserve(*json.load(sys.stdin)),end='')",
          script,
        ],
        {
          input: JSON.stringify([current, authority, copied]),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    const extra = original.replace(
      '"cogni-preview":',
      `${JSON.stringify({ "cogni-extra": 'a\\b "quoted"' }).slice(1, -1)},"cogni-preview":`
    );
    const published = addApprovedCandidate(extra, canonical);
    expect(selectCandidate(published, old)).toBe(extra);
    expect(readWorkerPatch(run(published, canonical, extra)).selected).toBe(
      readWorkerPatch(published).selected
    );
    expect(run(original, canonical, canonical)).toBe(original);
    const empty = selectCandidate(original, undefined);
    expect(run(empty, canonical, canonical)).toBe(empty);
    expect(() =>
      run(
        original.replaceAll(
          "https://poly-test.cognidao.org",
          "https://wrong.example"
        ),
        canonical,
        canonical
      )
    ).toThrow();
  });
});
