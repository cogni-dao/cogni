// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-repo-volume`
 * Purpose: Proves sandbox containers can mount the git-sync repo_data volume read-only.
 * Scope: Tests SandboxVolumeMount with the real repo_data volume populated by git-sync. Does not test LLM proxy or network isolation.
 * Invariants:
 *   - repo_data volume is readable at /repo/current inside sandbox
 *   - /repo is read-only (container cannot write)
 *   - /repo/current contains a valid git checkout (40-hex SHA)
 * Precondition: pnpm dev:stack (git-sync has populated repo_data)
 * Side-effects: IO (Docker containers, filesystem)
 * Links: docs/spec/sandboxed-agents.md, docs/spec/git-sync-repo-mount.md
 * @public
 */

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";

import {
  assertSandboxImageExists,
  cleanupWorkspace,
  createWorkspace,
  DEFAULT_LIMITS,
  SANDBOX_IMAGE,
  type SandboxTestContext,
  uniqueRunId,
} from "../../_fixtures/sandbox/fixtures";

const REPO_VOLUME = "repo_data";

let ctx: SandboxTestContext | null = null;

/** Check that repo_data volume exists (git-sync must have run) */
async function assertRepoVolumeExists(docker: Docker): Promise<void> {
  try {
    await docker.getVolume(REPO_VOLUME).inspect();
  } catch {
    throw new Error(
      `Volume ${REPO_VOLUME} not found. Start dev stack: pnpm dev:stack (git-sync populates this volume)`
    );
  }
}

/** Run a command in sandbox with repo_data volume mounted at /repo:ro */
async function runWithRepoVolume(context: SandboxTestContext, command: string) {
  return context.runner.runOnce({
    runId: uniqueRunId("repo-vol"),
    workspacePath: context.workspace,
    image: SANDBOX_IMAGE,
    argv: [command],
    limits: DEFAULT_LIMITS,
    volumes: [{ volume: REPO_VOLUME, containerPath: "/repo", readOnly: true }],
  });
}

describe("Sandbox Repo Volume Mount", () => {
  const docker = new Docker();

  beforeAll(async () => {
    await assertSandboxImageExists(docker);
    await assertRepoVolumeExists(docker);

    ctx = {
      runner: new SandboxRunnerAdapter(),
      workspace: await createWorkspace("sandbox-repo-vol"),
      docker,
    };
  });

  afterAll(async () => {
    if (ctx?.workspace) {
      await cleanupWorkspace(ctx.workspace);
    }
    ctx = null;
  });

  it("/repo/current/package.json is readable", async () => {
    if (!ctx) return;

    const result = await runWithRepoVolume(
      ctx,
      'test -f /repo/current/package.json && echo "REPO_READABLE" || echo "REPO_MISSING"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("REPO_READABLE");
  });

  it("/repo/current has valid 40-hex git SHA", async () => {
    if (!ctx) return;

    const result = await runWithRepoVolume(
      ctx,
      'SHA=$(git -C /repo/current rev-parse HEAD 2>/dev/null) && echo "SHA=$SHA" || echo "GIT_FAIL"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).not.toContain("GIT_FAIL");
    // Extract SHA and validate 40-hex format
    const match = result.stdout.match(/SHA=([0-9a-f]{40})/);
    expect(match).not.toBeNull();
  });

  it("/repo is mounted read-only at mount table level", async () => {
    if (!ctx) return;

    const result = await runWithRepoVolume(
      ctx,
      "grep ' /repo ' /proc/mounts | grep -q 'ro,' && echo MOUNT_RO || echo MOUNT_BAD"
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("MOUNT_RO");
  });

  it("container cannot write to /repo (read-only enforced)", async () => {
    if (!ctx) return;

    const result = await runWithRepoVolume(
      ctx,
      'touch /repo/current/_write_test 2>&1 && echo "WRITE_OK" || echo "WRITE_BLOCKED"'
    );

    expect(result.stdout).toContain("WRITE_BLOCKED");
    expect(result.stdout).not.toContain("WRITE_OK");
  });
});
