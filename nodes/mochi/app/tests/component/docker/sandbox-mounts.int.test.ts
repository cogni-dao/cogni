// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/sandbox/sandbox-mounts`
 * Purpose: Proves workspace and repo mount behavior for sandbox containers.
 * Scope: Tests mount permissions (rw/ro) only. Does not test network isolation.
 * Invariants:
 *   - Workspace mount is read-write
 *   - Additional mounts respect mode (ro/rw)
 *   - No orphan containers after tests
 * Side-effects: IO (Docker containers, filesystem)
 * Links: docs/spec/sandboxed-agents.md, src/adapters/server/sandbox/
 * @public
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  getRepoRootPath,
  mkWorkspace,
  SANDBOX_IMAGE,
  uniqueRunId,
  useSandboxFixture,
} from "./fixtures/sandbox-fixture";

describe("Sandbox Mounts", () => {
  const fixture = useSandboxFixture();

  describe("workspace (rw)", () => {
    it("container can write to /workspace", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-workspace-write"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: [
            'echo "hello-from-sandbox" > /workspace/test.txt && cat /workspace/test.txt',
          ],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
        });

        expect(result.ok).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello-from-sandbox");
      } finally {
        await cleanupWorkspace(workspace);
      }
    });

    it("host sees files written by container", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        await fixture.runner.runOnce({
          runId: uniqueRunId("test-workspace-host-read"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ['echo "visible-to-host" > /workspace/output.txt'],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
        });

        const content = await fs.readFile(
          path.join(workspace, "output.txt"),
          "utf8"
        );
        expect(content.trim()).toBe("visible-to-host");
      } finally {
        await cleanupWorkspace(workspace);
      }
    });
  });

  describe("repo mount (ro)", () => {
    /**
     * TODO: Replace getRepoRootPath() with SHA-specific worktree mount.
     * Current implementation mounts live repo root for testing the mount
     * mechanism. Production use requires deterministic SHA snapshots for
     * auditability per SANDBOXED_AGENTS.md HOST_SIDE_CLONE invariant.
     */

    it("container can read /repo", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();
      const repoPath = getRepoRootPath();

      try {
        // Use jq for robust JSON parsing - works in CI and locally
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-repo-readable"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: [
            "jq -er '.name' /repo/package.json >/dev/null && echo 'REPO_READABLE'",
          ],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
          mounts: [{ hostPath: repoPath, containerPath: "/repo", mode: "ro" }],
        });

        expect(result.ok).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("REPO_READABLE");
      } finally {
        await cleanupWorkspace(workspace);
      }
    });

    it("container cannot write to /repo (read-only enforced)", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();
      const repoPath = getRepoRootPath();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-repo-readonly"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ['echo "x" >> /repo/package.json 2>&1 || echo "WRITE_BLOCKED"'],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
          mounts: [{ hostPath: repoPath, containerPath: "/repo", mode: "ro" }],
        });

        expect(result.stdout).toContain("WRITE_BLOCKED");
      } finally {
        await cleanupWorkspace(workspace);
      }
    });
  });
});
