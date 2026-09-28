// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/deploy/node-preview-promote`
 * Purpose: Unit tests for the node-merge → preview tie facade.
 * Scope: Mocked deploy plane + service DB only; no real GitHub/DB I/O.
 * Invariants: MAIN_ADVANCE_ONLY, SPAWNED_NODES_ONLY, PIN_IS_MAIN_SHA, OBSERVED_DISPATCH.
 * Side-effects: none
 * Links: src/app/_facades/deploy/node-preview-promote.server.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const promoteNode = vi.fn();
let nodeRows: Array<{
  id: string;
  slug: string;
  deployEnvs?: string[] | null;
}> = [];

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

function mainPushPayload(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    after: "e".repeat(40),
    repository: {
      name: "habitat",
      default_branch: "main",
      owner: { login: "Cogni-DAO" },
    },
    ...over,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  nodeRows = [];
});

describe("dispatchNodePreviewPromote", () => {
  it("promotes the exact SHA from a default-branch push (merge-queue fallback)", async () => {
    nodeRows = [
      { id: "node-1", slug: "habitat", deployEnvs: ["preview", "production"] },
    ];
    promoteNode.mockResolvedValue({
      status: "dispatched",
      env: "preview",
      sourceSha: "e".repeat(40),
      sourceAddressing: "remote_source",
      workflowUrl:
        "https://github.com/Cogni-DAO/cogni/actions/workflows/promote-and-deploy.yml",
      runId: 12345,
      runUrl: "https://github.com/Cogni-DAO/cogni/actions/runs/12345",
      runApiUrl:
        "https://api.github.com/repos/Cogni-DAO/cogni/actions/runs/12345",
    });

    dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
    await flush();

    expect(promoteNode).toHaveBeenCalledWith({
      env: "preview",
      parentOwner: "Cogni-DAO",
      parentRepo: "node-template",
      slug: "habitat",
      sourceSha: "e".repeat(40),
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_preview_promote.complete",
        nodeId: "node-1",
        slug: "habitat",
        repo: "Cogni-DAO/habitat",
        sourceSha: "e".repeat(40),
        sourceSha8: "e".repeat(8),
        trigger: "push",
        status: "dispatched",
        runId: 12345,
        runUrl: "https://github.com/Cogni-DAO/cogni/actions/runs/12345",
        runApiUrl:
          "https://api.github.com/repos/Cogni-DAO/cogni/actions/runs/12345",
      }),
      expect.any(String)
    );
  });

  it("ignores a push that is not to the repository default branch", async () => {
    nodeRows = [
      { id: "node-1", slug: "habitat", deployEnvs: ["preview", "production"] },
    ];

    dispatchNodePreviewPromote(
      mainPushPayload({ ref: "refs/heads/feature/not-main" }),
      ENV,
      log
    );
    await flush();

    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("rejects when GitHub does not create an observable promotion run", async () => {
    nodeRows = [
      { id: "node-1", slug: "habitat", deployEnvs: ["preview", "production"] },
    ];
    promoteNode.mockRejectedValueOnce(new Error("run identity missing"));

    await expect(
      dispatchNodePreviewPromote(mainPushPayload(), ENV, log)
    ).rejects.toThrow("run identity missing");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_preview_promote.complete",
        repo: "Cogni-DAO/habitat",
        sourceSha: "e".repeat(40),
        sourceSha8: "e".repeat(8),
        trigger: "push",
        status: "failed",
        error: "Error: run identity missing",
      }),
      "node preview promote failed"
    );
  });

  it("does NOT dispatch for a node that has no preview env (bug.5203)", async () => {
    // Every fleet row became envs:[production] when #2238 retired the preview node slots.
    // Dispatching preview anyway resolved ZERO targets, so the run SKIPPED to a green
    // conclusion: beacon (run 35175805389) and toks5 (run 35176388003) each merged a fix,
    // showed success, and deployed nothing.
    nodeRows = [{ id: "node-1", slug: "habitat", deployEnvs: ["production"] }];
    dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("does NOT fall through to production when preview is absent", async () => {
    // Silence is correct here; SILENT was the bug. Auto-promoting a node merge to
    // production would ship unreviewed code past the human gate that makes production a
    // manual dispatch, so the skip must never become a production promote.
    nodeRows = [{ id: "node-1", slug: "habitat", deployEnvs: ["production"] }];
    dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
    expect(
      log.info.mock.calls.some(
        ([fields]: [Record<string, unknown>]) =>
          fields?.status === "skipped_no_preview_env"
      ),
      "the skip must be logged as its own terminal outcome, not silently dropped"
    ).toBe(true);
  });

  it("treats a missing deploy_envs projection as NOT in preview (fail closed)", async () => {
    nodeRows = [{ id: "node-1", slug: "habitat", deployEnvs: null }];
    dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
  });

  it("ignores an unregistered repo — flight-preview owns in-repo nodes (SPAWNED_NODES_ONLY)", async () => {
    nodeRows = [];
    dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
    await flush();
    expect(promoteNode).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_preview_promote.complete",
        sourceSha: "e".repeat(40),
        status: "skipped_unregistered_repo",
      }),
      expect.any(String)
    );
  });

  it("dispatches for node-template — the external-repo carve-out is retired (task.5087)", async () => {
    // node-template is a seeded registry row (story.5009) whose repo name == its slug, so it
    // resolves here. It deploys via the monorepo catalog like every node, so a merge on its
    // repo dispatches the same source-addressed preview promote.
    nodeRows = [
      {
        id: "node-nt",
        slug: "node-template",
        deployEnvs: ["preview", "production"],
      },
    ];
    promoteNode.mockResolvedValue({
      status: "dispatched",
      env: "preview",
      sourceSha: "b".repeat(40),
      sourceAddressing: "remote_source",
      workflowUrl:
        "https://github.com/Cogni-DAO/node-template/actions/workflows/promote-and-deploy.yml",
    });
    dispatchNodePreviewPromote(
      mainPushPayload({
        after: "d".repeat(40),
        repository: {
          name: "node-template",
          default_branch: "main",
          owner: { login: "Cogni-DAO" },
        },
      }),
      ENV,
      log
    );
    await flush();
    expect(promoteNode).toHaveBeenCalledWith({
      env: "preview",
      parentOwner: "Cogni-DAO",
      parentRepo: "node-template",
      slug: "node-template",
      sourceSha: "d".repeat(40),
    });
  });

  it("fails loudly when the deploy-plane GitHub App is unconfigured", async () => {
    nodeRows = [
      { id: "node-1", slug: "habitat", deployEnvs: ["preview", "production"] },
    ];
    await expect(
      dispatchNodePreviewPromote(
        mainPushPayload(),
        { ...ENV, GH_REVIEW_APP_ID: undefined },
        log
      )
    ).rejects.toThrow("GitHub App credentials missing");
    expect(promoteNode).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_preview_promote.complete",
        sourceSha: "e".repeat(40),
        status: "failed",
      }),
      expect.any(String)
    );
  });
});
