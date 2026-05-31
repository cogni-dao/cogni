// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/sandbox/sandbox-lifecycle`
 * Purpose: Proves container lifecycle behavior (stdout/stderr, exit codes, timeouts, cleanup).
 * Scope: Tests execution semantics only. Does not test network or mount variations.
 * Invariants:
 *   - Stdout/stderr captured separately
 *   - Exit codes propagated correctly
 *   - Timeouts kill containers cleanly
 *   - No orphan containers after tests
 * Side-effects: IO (Docker containers, filesystem)
 * Links: docs/spec/sandboxed-agents.md, src/adapters/server/sandbox/
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  mkWorkspace,
  SANDBOX_IMAGE,
  uniqueRunId,
  useSandboxFixture,
} from "./fixtures/sandbox-fixture";

describe("Sandbox Lifecycle", () => {
  const fixture = useSandboxFixture();

  describe("output capture", () => {
    it("captures stdout and stderr separately", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-stdout-stderr"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ['echo "stdout-content" && echo "stderr-content" >&2'],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
        });

        expect(result.ok).toBe(true);
        expect(result.stdout).toContain("stdout-content");
        expect(result.stderr).toContain("stderr-content");
      } finally {
        await cleanupWorkspace(workspace);
      }
    });
  });

  describe("exit codes", () => {
    it("returns exit code 0 on success", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-exit-zero"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ["exit 0"],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
        });

        expect(result.ok).toBe(true);
        expect(result.exitCode).toBe(0);
      } finally {
        await cleanupWorkspace(workspace);
      }
    });

    it("returns non-zero exit code on failure", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-exit-code"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ["exit 42"],
          limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
        });

        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(42);
      } finally {
        await cleanupWorkspace(workspace);
      }
    });
  });

  describe("timeouts", () => {
    it("kills container and returns timeout error", async () => {
      if (!fixture.imageAvailable || !fixture.runner) return;

      const workspace = await mkWorkspace();

      try {
        const result = await fixture.runner.runOnce({
          runId: uniqueRunId("test-timeout"),
          workspacePath: workspace,
          image: SANDBOX_IMAGE,
          argv: ["sleep 60"],
          limits: { maxRuntimeSec: 2, maxMemoryMb: 128 },
        });

        expect(result.ok).toBe(false);
        expect(result.errorCode).toBe("timeout");
      } finally {
        await cleanupWorkspace(workspace);
      }
    }, 10000);
  });

  describe("cleanup", () => {
    it("no orphan containers remain after run", async () => {
      // Implicitly tested by afterEach hook in useSandboxFixture
      // The hook will fail if orphans are found
      expect(true).toBe(true);
    });
  });
});
