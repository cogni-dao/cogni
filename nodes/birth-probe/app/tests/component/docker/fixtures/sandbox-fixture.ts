// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/sandbox/fixtures/sandbox-fixture`
 * Purpose: Shared test fixtures for sandbox component tests.
 * Scope: Provides runner setup, workspace helpers, cleanup. Does not contain test assertions.
 * Invariants:
 *   - Cleanup always runs, even on test failure
 *   - No orphan containers left behind
 * Side-effects: IO (Docker containers, filesystem)
 * Links: tests/component/sandbox/
 * @internal
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Docker from "dockerode";
import { beforeAll } from "vitest";

import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";

export const SANDBOX_IMAGE = "cogni-sandbox-runtime:latest";

/**
 * Check if sandbox image is available.
 * In CI, image should be pre-built; locally it may need manual build.
 */
async function checkImageAvailable(docker: Docker): Promise<boolean> {
  try {
    await docker.getImage(SANDBOX_IMAGE).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Docker network exists.
 * Used for conditional test execution when dev stack may not be running.
 */
export async function checkNetworkAvailable(
  docker: Docker,
  networkName: string
): Promise<boolean> {
  try {
    await docker.getNetwork(networkName).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique run ID for tests to avoid collision.
 */
export function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a temporary workspace directory.
 */
export async function mkWorkspace(prefix = "sandbox-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Clean up a workspace directory.
 */
export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await fs.rm(workspacePath, { recursive: true, force: true });
}

/**
 * Get the repo root path for read-only mount tests.
 * Uses GITHUB_WORKSPACE in CI, falls back to cwd locally.
 *
 * TODO: Replace with SHA-specific worktree mount for auditability.
 * Current implementation mounts live repo root for testing the mount
 * mechanism. Production use requires deterministic SHA snapshots for
 * auditability per SANDBOXED_AGENTS.md HOST_SIDE_CLONE invariant.
 */
export function getRepoRootPath(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/**
 * Shared test context for sandbox tests.
 * IMPORTANT: Access properties via the returned object, not destructuring,
 * because values are set in beforeAll which runs after module load.
 */
export interface SandboxFixture {
  readonly docker: Docker;
  runner: SandboxRunnerAdapter | undefined;
  imageAvailable: boolean;
  /** Unique prefix for this test file's containers */
  readonly containerPrefix: string;
}

/**
 * Setup shared test context for sandbox tests.
 * Returns a mutable fixture object - access via fixture.runner, not destructuring.
 *
 * @example
 * ```ts
 * const fixture = useSandboxFixture();
 *
 * it("test", async () => {
 *   if (!fixture.imageAvailable) return; // Use fixture.X, not destructured
 *   await fixture.runner!.runOnce(...);
 * });
 * ```
 */
export function useSandboxFixture(): SandboxFixture {
  // Generate unique prefix per test file to avoid cross-file orphan detection
  const containerPrefix = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const fixture: SandboxFixture = {
    docker: new Docker(),
    runner: undefined,
    imageAvailable: false,
    containerPrefix,
  };

  beforeAll(async () => {
    fixture.imageAvailable = await checkImageAvailable(fixture.docker);

    if (!fixture.imageAvailable) {
      // In CI, this is a hard failure - image should be pre-built
      // Locally, warn and skip
      const isCI = process.env.CI === "true";
      const message = `Sandbox image ${SANDBOX_IMAGE} not found. Run: docker build -t ${SANDBOX_IMAGE} services/sandbox-runtime`;

      if (isCI) {
        throw new Error(`CI FAILURE: ${message}`);
      }
      console.warn(`SKIPPING SANDBOX TESTS: ${message}`);
      return;
    }

    fixture.runner = new SandboxRunnerAdapter();
  });

  // Note: No afterEach orphan check - tests run in parallel and would see
  // containers from other test files. Cleanup happens in adapter's finally block.

  // Note: No afterAll cleanup needed - the adapter's finally block handles cleanup.
  // Aggressive cleanup here would race with parallel test files.

  return fixture;
}
