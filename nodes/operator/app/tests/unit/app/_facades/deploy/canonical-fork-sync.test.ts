// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/unit/app/_facades/deploy/canonical-fork-sync`
 * Purpose: Unit-prove the push guard + the three-tier fan-out (CI overwrite + substrate merge with the
 *   Tier-3 carve-out threaded in), incl. per-tier per-fork error isolation.
 * Scope: Pure `extractTemplateMainPush` + `fanOutForkSync` with a fake deploy plane. No GitHub/DB.
 * Links: src/app/_facades/deploy/canonical-fork-sync.server.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  extractTemplateMainPush,
  type ForkSyncTarget,
  fanOutForkSync,
  type TemplateMainPush,
} from "@/app/_facades/deploy/canonical-fork-sync.server";
import type {
  DeployPlanePort,
  MirrorCanonicalFilesResult,
  SyncTemplateUpstreamInput,
  SyncTemplateUpstreamResult,
} from "@/ports";

const pushPayload = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: "a".repeat(40),
  repository: {
    name: "node-template",
    default_branch: "main",
    owner: { login: "Cogni-DAO" },
    ...((over.repository as object) ?? {}),
  },
  ...over,
});

describe("extractTemplateMainPush", () => {
  it("accepts a node-template default-branch push and captures the branch", () => {
    expect(extractTemplateMainPush(pushPayload(), "Cogni-DAO")).toEqual({
      sourceOwner: "Cogni-DAO",
      sourceRepo: "node-template",
      defaultBranch: "main",
      afterSha: "a".repeat(40),
    });
  });

  it("rejects a different owner (env-driven identity)", () => {
    expect(extractTemplateMainPush(pushPayload(), "cogni-test-org")).toBeNull();
  });

  it("rejects a non-template repo", () => {
    expect(
      extractTemplateMainPush(
        pushPayload({ repository: { name: "blue" } }),
        "Cogni-DAO"
      )
    ).toBeNull();
  });

  it("rejects a push to a non-default branch", () => {
    expect(
      extractTemplateMainPush(
        pushPayload({ ref: "refs/heads/feature/x" }),
        "Cogni-DAO"
      )
    ).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(extractTemplateMainPush({}, "Cogni-DAO")).toBeNull();
  });
});

const CTX: TemplateMainPush = {
  sourceOwner: "Cogni-DAO",
  sourceRepo: "node-template",
  defaultBranch: "main",
  afterSha: "a".repeat(40),
};

const TARGETS: ForkSyncTarget[] = [
  { owner: "cogni-test-org", name: "blue", slug: "blue" },
  { owner: "cogni-test-org", name: "oss", slug: "oss" },
];

const NODE_LOCAL = ["app/src/app/(public)/**", ".cogni/repo-spec.yaml"];

function fakePlane(over: {
  ci?: (repo: string) => Promise<MirrorCanonicalFilesResult>;
  upstream?: (
    i: SyncTemplateUpstreamInput
  ) => Promise<SyncTemplateUpstreamResult>;
}): DeployPlanePort {
  return {
    syncCanonicalFilesToFork: vi.fn((i: { targetRepo: string }) =>
      (
        over.ci ??
        (async () => ({ status: "no_changes", branch: "b", changedPaths: [] }))
      )(i.targetRepo)
    ),
    syncTemplateUpstreamToFork: vi.fn((i: SyncTemplateUpstreamInput) =>
      (over.upstream ?? (async () => ({ status: "up_to_date" })))(i)
    ),
  } as unknown as DeployPlanePort;
}

describe("fanOutForkSync — three tiers, per-tier per-fork isolation", () => {
  it("records both PR-opening tiers per fork and threads Tier-3 globs into the merge", async () => {
    const plane = fakePlane({
      ci: async (repo) => ({
        status: "pr_opened",
        branch: "cogni-operator/sync-canonical-abcd1234",
        prNumber: 1,
        prUrl: `https://github.com/cogni-test-org/${repo}/pull/1`,
        changedPaths: [".github/workflows/ci.yaml"],
      }),
      upstream: async (i) => ({
        status: "pr_opened",
        prNumber: 2,
        prUrl: `https://github.com/cogni-test-org/${i.forkRepo}/pull/2`,
      }),
    });
    const entries = await fanOutForkSync(plane, CTX, TARGETS, NODE_LOCAL);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.ci === "pr_opened")).toBe(true);
    expect(entries.every((e) => e.template === "pr_opened")).toBe(true);
    expect(entries[0]?.ciPrUrl).toContain("/pull/1");
    expect(entries[0]?.templatePrUrl).toContain("/pull/2");
    // Tier 3 is DATA: the resolved node-local globs flow into every fork's Tier-2 merge.
    expect(plane.syncTemplateUpstreamToFork).toHaveBeenCalledWith(
      expect.objectContaining({ nodeLocalPaths: NODE_LOCAL })
    );
  });

  it("Tier 1 failure does NOT block Tier 2 (decoupled), and vice versa", async () => {
    const plane = fakePlane({
      ci: async (repo) => {
        if (repo === "blue") throw new Error("App not installed");
        return { status: "no_changes", branch: "b", changedPaths: [] };
      },
      upstream: async (i) => {
        if (i.forkRepo === "oss")
          throw new Error("merge conflict compute failed");
        return { status: "pr_opened", prNumber: 9, prUrl: "u" };
      },
    });
    const entries = await fanOutForkSync(plane, CTX, TARGETS, NODE_LOCAL);
    const blue = entries.find((e) => e.target.endsWith("/blue"));
    const oss = entries.find((e) => e.target.endsWith("/oss"));
    // blue: Tier 1 failed but Tier 2 still ran and opened.
    expect(blue?.ci).toBe("failed");
    expect(blue?.template).toBe("pr_opened");
    // oss: Tier 1 fine, Tier 2 failed — isolated.
    expect(oss?.ci).toBe("no_changes");
    expect(oss?.template).toBe("failed");
    expect(plane.syncCanonicalFilesToFork).toHaveBeenCalledTimes(2);
    expect(plane.syncTemplateUpstreamToFork).toHaveBeenCalledTimes(2);
  });

  it("up_to_date upstream is a clean Tier-2 outcome", async () => {
    const plane = fakePlane({}); // defaults: ci no_changes, upstream up_to_date
    const entries = await fanOutForkSync(
      plane,
      CTX,
      [TARGETS[0] as ForkSyncTarget],
      NODE_LOCAL
    );
    expect(entries[0]?.template).toBe("up_to_date");
    expect(entries[0]?.templatePrUrl).toBeUndefined();
  });
});
