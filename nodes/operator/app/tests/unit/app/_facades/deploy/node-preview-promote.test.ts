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

let catalogRow: unknown;
const recordNodeRelease = vi.fn();
const getDesired = vi.fn();
const getRelease = vi.fn();
let declared: Array<{ name: string; kind: "app" | "state" }> = [];

vi.mock("@/shared/config", () => ({ getNodeId: () => "operator-node-id" }));
vi.mock("@/bootstrap/capabilities/node-catalog", () => ({
  createNodeCatalog: () => ({
    entryFor: async () =>
      catalogRow === undefined ? undefined : { row: catalogRow },
  }),
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => ({ getDesired, getRelease }),
}));
vi.mock("@/bootstrap/capabilities/node-source-resolver", () => ({
  createNodeSourceResolver: () => ({
    resolveNodeSource: async () => ({ owner: "Cogni-DAO", repo: "habitat" }),
  }),
  createDeclarationReader: () => ({}),
}));
vi.mock("@/features/node-deploy/read-declarations", () => ({
  readWorkloadDeclarations: async () => ({
    kind: "ok",
    repoSpecText: "",
    manifests: [],
  }),
}));
vi.mock("@cogni/repo-spec", () => ({
  lowerWorkloadManifests: () => declared,
}));
vi.mock("@/app/_facades/deploy/record-node-release.server", () => ({
  recordNodeRelease: (...a: unknown[]) => recordNodeRelease(...a),
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
  DEPLOY_ENVIRONMENT: "production",
  NODE_DEPLOY_ENVS: "candidate-a,preview,production",
  FLEET_CONTROL_ENV: "production",
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
  catalogRow = undefined;
  declared = [];
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

  describe("node-deploy preview cell (task.5410)", () => {
    const SHA = "e".repeat(40);
    beforeEach(() => {
      nodeRows = [
        {
          id: "node-1",
          slug: "habitat",
          deployEnvs: ["preview", "production"],
        },
      ];
      catalogRow = {
        name: "habitat",
        source_repo: "https://github.com/Cogni-DAO/habitat",
        compute_api: { preview: "node-deploy" },
      };
      declared = [
        { name: "web", kind: "app" },
        { name: "db", kind: "state" },
        { name: "worker", kind: "app" },
      ];
      getDesired.mockResolvedValue(undefined);
      recordNodeRelease.mockResolvedValue({
        ok: true,
        releaseId: "rel-1",
        desiredState: "running",
      });
    });

    it("records an env=preview release per app workload as the operator and never dispatches", async () => {
      await dispatchNodePreviewPromote(mainPushPayload(), ENV, log);

      expect(promoteNode).not.toHaveBeenCalled();
      expect(recordNodeRelease).toHaveBeenCalledTimes(2);
      expect(recordNodeRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          node: { id: "node-1", slug: "habitat" },
          env: "preview",
          workload: "web",
          sourceSha: SHA,
          createdBy: "operator:merge-webhook",
        })
      );
      expect(recordNodeRelease).toHaveBeenCalledWith(
        expect.objectContaining({ workload: "worker", env: "preview" })
      );
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "feature.node_preview_promote.complete",
          status: "recorded",
          workload: "web",
          releaseId: "rel-1",
          sourceSha: SHA,
        }),
        expect.any(String)
      );
    });

    it("logs duplicate and records nothing when the sha is already desired", async () => {
      getDesired.mockResolvedValue({ releaseId: "rel-0" });
      getRelease.mockResolvedValue({ id: "rel-0", sourceSha: SHA });

      await dispatchNodePreviewPromote(mainPushPayload(), ENV, log);

      expect(recordNodeRelease).not.toHaveBeenCalled();
      expect(promoteNode).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ status: "duplicate", releaseId: "rel-0" }),
        expect.any(String)
      );
    });

    it("rejects (500 path) when a workload release is refused", async () => {
      recordNodeRelease.mockResolvedValue({
        ok: false,
        status: 422,
        body: { error: "workload_manifest_refused" },
      });
      await expect(
        dispatchNodePreviewPromote(mainPushPayload(), ENV, log)
      ).rejects.toThrow("preview release refused for: web, worker");
      expect(promoteNode).not.toHaveBeenCalled();
    });

    it("preview not served by this operator: skipped_env_not_served, nothing recorded", async () => {
      await dispatchNodePreviewPromote(
        mainPushPayload(),
        { ...ENV, NODE_DEPLOY_ENVS: "production" },
        log
      );
      expect(recordNodeRelease).not.toHaveBeenCalled();
      expect(promoteNode).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped_env_not_served" }),
        expect.any(String)
      );
    });

    it("fleet mismatch (catalog repo owned by another org): skipped_node_not_in_fleet", async () => {
      catalogRow = {
        name: "habitat",
        source_repo: "https://github.com/cogni-test-org/habitat",
        compute_api: { preview: "node-deploy" },
      };
      await dispatchNodePreviewPromote(mainPushPayload(), ENV, log);
      expect(recordNodeRelease).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped_node_not_in_fleet" }),
        expect.any(String)
      );
    });

    it("pushed repo is not the catalog source repo: skipped_repo_mismatch", async () => {
      await dispatchNodePreviewPromote(
        mainPushPayload({
          repository: {
            name: "habitat",
            default_branch: "main",
            owner: { login: "someone-else" },
          },
        }),
        ENV,
        log
      );
      expect(recordNodeRelease).not.toHaveBeenCalled();
      expect(promoteNode).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped_repo_mismatch" }),
        expect.any(String)
      );
    });

    it("repo comparison is case-insensitive", async () => {
      await dispatchNodePreviewPromote(
        mainPushPayload({
          repository: {
            name: "habitat",
            default_branch: "main",
            owner: { login: "COGNI-dao" },
          },
        }),
        ENV,
        log
      );
      expect(recordNodeRelease).toHaveBeenCalledTimes(2);
    });

    it("a thrown record error does not starve later workloads; throws once at the end", async () => {
      recordNodeRelease.mockRejectedValueOnce(new Error("db down"));
      await expect(
        dispatchNodePreviewPromote(mainPushPayload(), ENV, log)
      ).rejects.toThrow("preview release refused for: web");
      expect(recordNodeRelease).toHaveBeenCalledTimes(2);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ status: "record_failed", workload: "web" }),
        expect.any(String)
      );
    });

    it("a non-main push records nothing", async () => {
      await dispatchNodePreviewPromote(
        mainPushPayload({ ref: "refs/heads/feature/x" }),
        ENV,
        log
      );
      expect(recordNodeRelease).not.toHaveBeenCalled();
      expect(promoteNode).not.toHaveBeenCalled();
    });

    it("a crossplane cell keeps the legacy dispatch and records nothing", async () => {
      catalogRow = { name: "habitat", compute_api: { preview: "crossplane" } };
      promoteNode.mockResolvedValue({ status: "dispatched" });

      await dispatchNodePreviewPromote(mainPushPayload(), ENV, log);

      expect(promoteNode).toHaveBeenCalledTimes(1);
      expect(recordNodeRelease).not.toHaveBeenCalled();
    });
  });
});
