// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@tests/unit/adapters/server/vcs/maintenance-cancel`
 * Purpose: Exercise the operator's exact legacy-fence cancellation contract.
 * Scope: Recording GitHub transport; does not use credentials or mutate remote state.
 * Invariants: only an unchanged unexecuted marker is removed; races fail closed.
 * Side-effects: none
 * Links: task.5345
 * @internal
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "test" }),
}));
vi.mock("@octokit/core", () => ({
  Octokit: class {
    request = state.request;
  },
}));

import { GitHubRepoWriter } from "@/adapters/server/vcs/github-repo-write";

const head = "a".repeat(40),
  base = "b".repeat(40),
  tree = "c".repeat(40),
  commit = "d".repeat(40);
const nodeId = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const marker = () => ({
  version: 1,
  phase: "fenced",
  operationId: "1".repeat(64),
  request: {
    nodeId,
    slug: "node-template",
    env: "candidate-a",
    sourceRepository: "cogni-test-org/node-template",
    expected: { deployCommit: base },
  },
  phaseEvidence: { phase: "fenced", nodeId, environment: "candidate-a" },
});
let bytes: string;
let active: boolean;
let receipt: boolean;
let mode: string;
let drift: boolean;
let conflict: boolean;
let inventoryCalls: number;
let raceAtSecondInventory: boolean;
function input() {
  return {
    nodeId,
    slug: "node-template",
    env: "candidate-a" as const,
    operationId: "1".repeat(64),
    expectedDeployHead: head,
    expectedMarkerSha256: createHash("sha256").update(bytes).digest("hex"),
    reason: "Abandoned unexecuted intent",
    actorId: "user:test",
  };
}
function writer() {
  return new GitHubRepoWriter({
    appId: "test",
    privateKey: "test",
    parentOwner: "cogni-test-org",
    parentRepo: "cogni-monorepo",
  });
}
const mutations = () =>
  state.request.mock.calls.filter(([route]) =>
    /^(POST|PATCH|DELETE)/.test(route)
  );
beforeEach(() => {
  bytes = JSON.stringify(marker());
  active = false;
  receipt = false;
  mode = "100644";
  drift = false;
  conflict = false;
  inventoryCalls = 0;
  raceAtSecondInventory = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ id: 1 }) }))
  );
  state.request.mockReset();
  state.request.mockImplementation(
    async (route: string, p: Record<string, unknown>) => {
      if (route.includes("/installation")) return { data: { id: 1 } };
      if (route.includes("/contents/"))
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(
              `name: node-template\nnode_id: ${nodeId}\nenvs: [candidate-a]\ncandidate_a_branch: deploy/candidate-a-node-template\nsource_repo: https://github.com/cogni-test-org/node-template.git\n`
            ).toString("base64"),
          },
        };
      if (route.startsWith("GET") && route.includes("/git/ref/"))
        return { data: { object: { sha: head } } };
      if (route.startsWith("GET") && route.includes("/git/commits/"))
        return {
          data: {
            tree: { sha: p.commit_sha === base ? tree : "current-tree" },
          },
        };
      if (route.startsWith("GET") && route.includes("/git/trees/"))
        return {
          data: {
            truncated: false,
            tree:
              p.tree_sha === "current-tree"
                ? [
                    {
                      path: ".promote-state",
                      type: "tree",
                      mode: "040000",
                      sha: "state-tree",
                    },
                  ]
                : [
                    {
                      path: "maintenance-drain.json",
                      type: "blob",
                      mode,
                      sha: "marker-blob",
                      size: bytes.length,
                    },
                    ...(receipt
                      ? [
                          {
                            path: "maintenance-drain-receipt.json",
                            type: "blob",
                            mode: "100644",
                            sha: "receipt",
                          },
                        ]
                      : []),
                  ],
          },
        };
      if (route.includes("/git/blobs/"))
        return {
          data: {
            encoding: "base64",
            content: Buffer.from(bytes).toString("base64"),
            size: bytes.length,
          },
        };
      if (route.includes("/actions/runs")) {
        inventoryCalls++;
        return {
          data: {
            total_count: 0,
            workflow_runs:
              active || (raceAtSecondInventory && inventoryCalls > 6)
                ? [
                    {
                      status: "in_progress",
                      path: ".github/workflows/candidate-flight.yml",
                    },
                  ]
                : [],
          },
        };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees")
        return { data: { sha: drift ? "wrong-tree" : tree } };
      if (route === "POST /repos/{owner}/{repo}/git/commits")
        return { data: { sha: commit } };
      if (route.startsWith("PATCH")) {
        if (conflict)
          throw Object.assign(new Error("changed"), { status: 422 });
        return { data: { object: { sha: commit } } };
      }
      throw new Error(`Unexpected ${route}`);
    }
  );
});
describe("cancelCandidateMaintenance", () => {
  it("deletes only the marker, preserving the old tree and refusing force", async () => {
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).resolves.toMatchObject({
      commitSha: commit,
      previousHead: head,
      treeSha: tree,
    });
    const calls = mutations();
    expect(calls[0]?.[1]).toMatchObject({
      base_tree: "current-tree",
      tree: [
        {
          path: ".promote-state/maintenance-drain.json",
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    });
    expect(calls[1]?.[1]).toMatchObject({ parents: [head], tree });
    expect(calls[2]?.[1]).toMatchObject({
      ref: "heads/deploy/candidate-a-node-template",
      sha: commit,
      force: false,
    });
  });
  it.each([
    "phase",
    "operation",
    "node",
    "source",
    "evidence",
  ])("refuses mismatched %s before mutation", async (field) => {
    const m = marker();
    if (field === "phase") m.phase = "drained";
    if (field === "operation") m.operationId = "2".repeat(64);
    if (field === "node") m.request.nodeId = "other";
    if (field === "source")
      m.request.sourceRepository = "cogni-dao/node-template";
    if (field === "evidence") m.phaseEvidence.phase = "drained";
    bytes = JSON.stringify(m);
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations()).toHaveLength(0);
  });
  it.each([
    "head",
    "hash",
    "receipt",
    "symlink",
    "workflow",
  ])("refuses %s before mutation", async (field) => {
    const p = input();
    if (field === "head") p.expectedDeployHead = base;
    if (field === "hash") p.expectedMarkerSha256 = "0".repeat(64);
    if (field === "receipt") receipt = true;
    if (field === "symlink") mode = "120000";
    if (field === "workflow") active = true;
    await expect(writer().cancelCandidateMaintenance(p)).rejects.toMatchObject({
      status: 409,
    });
    expect(mutations()).toHaveLength(0);
  });
  it("refuses runtime tree drift without creating a commit", async () => {
    drift = true;
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations().some(([r]) => r.includes("/commits"))).toBe(false);
  });
  it("does not move the ref if delivery starts during preparation", async () => {
    raceAtSecondInventory = true;
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations().some(([r]) => r.startsWith("PATCH"))).toBe(false);
  });
  it("does not retry a concurrent Git write", async () => {
    conflict = true;
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations().filter(([r]) => r.startsWith("PATCH"))).toHaveLength(1);
  });
  it("fails closed on incomplete workflow inventory", async () => {
    const original = state.request.getMockImplementation();
    state.request.mockImplementation(async (route, params) =>
      route.includes("/actions/runs")
        ? { data: { total_count: 100, workflow_runs: [] } }
        : original?.(route, params)
    );
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ code: "maintenance_inventory_incomplete" });
    expect(mutations()).toHaveLength(0);
  });
  it("fails closed on workflow transport failure", async () => {
    const original = state.request.getMockImplementation();
    state.request.mockImplementation(async (route, params) => {
      if (route.includes("/actions/runs")) throw new Error("unavailable");
      return original?.(route, params);
    });
    await expect(writer().cancelCandidateMaintenance(input())).rejects.toThrow(
      "unavailable"
    );
    expect(mutations()).toHaveLength(0);
  });
  it("refuses a foreign catalog UUID before deploy-state reads", async () => {
    const original = state.request.getMockImplementation();
    state.request.mockImplementation(async (route, params) => {
      const r = await original?.(route, params);
      if (route.includes("/contents/"))
        r.data.content = Buffer.from(
          `name: node-template\nnode_id: 11111111-1111-4111-8111-111111111111\nenvs: [candidate-a]\n`
        ).toString("base64");
      return r;
    });
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ code: "maintenance_catalog_mismatch" });
    expect(mutations()).toHaveLength(0);
  });
  it("refuses malformed marker JSON", async () => {
    bytes = "{";
    await expect(
      writer().cancelCandidateMaintenance(input())
    ).rejects.toMatchObject({ code: "maintenance_marker_invalid" });
    expect(mutations()).toHaveLength(0);
  });
  it("refuses unconfigured custody before contacting GitHub", async () => {
    const w = new GitHubRepoWriter({ appId: "test", privateKey: "test" });
    await expect(w.cancelCandidateMaintenance(input())).rejects.toMatchObject({
      status: 503,
    });
    expect(state.request).not.toHaveBeenCalled();
  });
});
