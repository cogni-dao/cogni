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

const promoteNodeToPreview = vi.fn();
let nodeRows: Array<{ id: string; slug: string }> = [];

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({ promoteNodeToPreview }),
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
  promoteNodeToPreview.mockReset();
  nodeRows = [];
});

describe("dispatchNodePreviewPromote", () => {
  it("pins the PR head SHA when a registered node's PR merges (PIN_IS_PR_HEAD_SHA)", async () => {
    nodeRows = [{ id: "node-1", slug: "habitat" }];
    promoteNodeToPreview.mockResolvedValue({
      status: "pin_pr_opened",
      prNumber: 99,
      prUrl: "https://github.com/Cogni-DAO/node-template/pull/99",
      currentSha: "b".repeat(40),
      autoMergeEnabled: true,
    });

    dispatchNodePreviewPromote(mergedPayload(), ENV, log);
    await flush();

    expect(promoteNodeToPreview).toHaveBeenCalledWith({
      parentOwner: "Cogni-DAO",
      parentRepo: "node-template",
      slug: "habitat",
      sourceSha: "a".repeat(40),
    });
  });

  it("ignores a closed-but-unmerged PR (MERGED_ONLY)", async () => {
    nodeRows = [{ id: "node-1", slug: "habitat" }];
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
    expect(promoteNodeToPreview).not.toHaveBeenCalled();
  });

  it("ignores a non-closed action", async () => {
    nodeRows = [{ id: "node-1", slug: "habitat" }];
    dispatchNodePreviewPromote(mergedPayload({ action: "opened" }), ENV, log);
    await flush();
    expect(promoteNodeToPreview).not.toHaveBeenCalled();
  });

  it("ignores an unregistered repo — flight-preview owns in-repo nodes (SPAWNED_NODES_ONLY)", async () => {
    nodeRows = [];
    dispatchNodePreviewPromote(mergedPayload(), ENV, log);
    await flush();
    expect(promoteNodeToPreview).not.toHaveBeenCalled();
  });

  it("no-ops when the deploy-plane GitHub App is unconfigured", async () => {
    nodeRows = [{ id: "node-1", slug: "habitat" }];
    dispatchNodePreviewPromote(
      mergedPayload(),
      { ...ENV, GH_REVIEW_APP_ID: undefined },
      log
    );
    await flush();
    expect(promoteNodeToPreview).not.toHaveBeenCalled();
  });
});
