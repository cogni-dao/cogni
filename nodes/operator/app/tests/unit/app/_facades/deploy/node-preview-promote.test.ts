// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/deploy/node-preview-promote`
 * Purpose: Unit tests for the node-merge → preview tie facade.
 * Scope: Mocked deploy plane + service DB only; no real GitHub/DB I/O.
 * Invariants: MERGED_ONLY, SPAWNED_NODES_ONLY, PIN_IS_PR_HEAD_SHA.
 * Side-effects: none
 * Links: src/app/_facades/deploy/node-preview-promote.server.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const promoteNode = vi.fn();
let nodeRows: Array<{
  id: string;
  slug: string;
  repoOwner: string;
  repoName: string;
}> = [];

// The spawned-only guard compares each node's repo coords to the parent monorepo.
vi.mock("@/shared/config", () => ({
  getGithubRepo: () => ({ owner: "cogni-dao", repo: "cogni" }),
}));

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({ promoteNode }),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => nodeRows,
        }),
      }),
    }),
  }),
}));

import { dispatchNodePreviewPromote } from "@/app/_facades/deploy/node-preview-promote.server";

const ENV = {
  GH_REVIEW_APP_ID: "123",
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
  NODE_SUBMODULE_PARENT_OWNER: "Cogni-DAO",
  NODE_SUBMODULE_PARENT_REPO: "node-template",
  // biome-ignore lint/suspicious/noExplicitAny: partial ServerEnv is sufficient for this facade
} as any;

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino Logger stub
} as any;

function mergedPayload(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    action: "closed",
    repository: { name: "habitat", owner: { login: "Cogni-DAO" } },
    pull_request: {
      number: 7,
      merged: true,
      head: { sha: "a".repeat(40) },
    },
    ...over,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  promoteNode.mockReset();
  nodeRows = [];
});

describe("dispatchNodePreviewPromote", () => {
  it("pins the PR head SHA when a registered node's PR merges (PIN_IS_PR_HEAD_SHA)", async () => {
    nodeRows = [
      {
        id: "node-1",
        slug: "habitat",
        repoOwner: "cogni-dao",
        repoName: "cogni",
      },
    ];
    promoteNode.mockResolvedValue({
      status: "dispatched",
      env: "preview",
      sourceSha: "a".repeat(40),
      sourceAddressing: "remote_source",
      workflowUrl:
        "https://github.com/Cogni-DAO/node-template/actions/workflows/promote-and-deploy.yml",
    });

    dispatchNodePreviewPromote(mergedPayload(), ENV, log);
    await flush();

    expect(promoteNode).toHaveBeenCalledWith({
      env: "preview",
      parentOwner: "Cogni-DAO",
      parentRepo: "node-template",
      slug: "habitat",
      sourceSha: "a".repeat(40),
    });
  });

  it("ignores a closed-but-unmerged PR (MERGED_ONLY)", async () => {
    nodeRows = [
      {
        id: "node-1",
        slug: "habitat",
        repoOwner: "cogni-dao",
        repoName: "cogni",
      },
    ];
    dispatchNodePreviewPromote(
      mergedPayload({
        pull_request: {
          number: 7,
          merged: false,
          head: { sha: "a".repeat(40) },
        },
      }),
      ENV,
      log
    );
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("ignores a non-closed action", async () => {
    nodeRows = [
      {
        id: "node-1",
        slug: "habitat",
        repoOwner: "cogni-dao",
        repoName: "cogni",
      },
    ];
    dispatchNodePreviewPromote(mergedPayload({ action: "opened" }), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("ignores an unregistered repo — flight-preview owns in-repo nodes (SPAWNED_NODES_ONLY)", async () => {
    nodeRows = [];
    dispatchNodePreviewPromote(mergedPayload(), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("skips a registered external-repo node — it owns its own deploy pipeline (SPAWNED_NODES_ONLY)", async () => {
    // node-template is a seeded registry row carrying its OWN repo; its repo name == its slug, so it
    // resolves here. The guard must skip it (it is not deployed via the parent monorepo).
    nodeRows = [
      {
        id: "node-nt",
        slug: "node-template",
        repoOwner: "cogni-dao",
        repoName: "node-template",
      },
    ];
    dispatchNodePreviewPromote(
      mergedPayload({
        repository: { name: "node-template", owner: { login: "Cogni-DAO" } },
      }),
      ENV,
      log
    );
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("no-ops when the deploy-plane GitHub App is unconfigured", async () => {
    nodeRows = [
      {
        id: "node-1",
        slug: "habitat",
        repoOwner: "cogni-dao",
        repoName: "cogni",
      },
    ];
    dispatchNodePreviewPromote(
      mergedPayload(),
      { ...ENV, GH_REVIEW_APP_ID: undefined },
      log
    );
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });
});
