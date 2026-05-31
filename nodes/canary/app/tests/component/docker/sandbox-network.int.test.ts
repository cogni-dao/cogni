// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/sandbox/sandbox-network`
 * Purpose: Proves network isolation for sandbox containers.
 * Scope: Tests network=none enforcement only. Does not test mount variations or LLM integration.
 * Invariants:
 *   - Network=none blocks all external access
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

describe("Sandbox Network Isolation", () => {
  const fixture = useSandboxFixture();

  it("network=none blocks external access", async () => {
    if (!fixture.imageAvailable || !fixture.runner) return;

    const workspace = await mkWorkspace();

    try {
      const result = await fixture.runner.runOnce({
        runId: uniqueRunId("test-network-isolation"),
        workspacePath: workspace,
        image: SANDBOX_IMAGE,
        argv: [
          "bash",
          "-lc",
          "curl -s --max-time 2 http://example.com 2>&1 || echo 'NETWORK_BLOCKED'",
        ],
        limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
      });

      // curl should fail, fallback message should appear
      expect(result.stdout).toContain("NETWORK_BLOCKED");
      // Should NOT get actual example.com content
      expect(result.stdout).not.toContain("<!doctype html>");
      expect(result.stdout).not.toContain("Example Domain");
    } finally {
      await cleanupWorkspace(workspace);
    }
  });

  it("DNS resolution fails (no network)", async () => {
    if (!fixture.imageAvailable || !fixture.runner) return;

    const workspace = await mkWorkspace();

    try {
      const result = await fixture.runner.runOnce({
        runId: uniqueRunId("test-dns-blocked"),
        workspacePath: workspace,
        image: SANDBOX_IMAGE,
        argv: [
          "bash",
          "-lc",
          "getent hosts example.com 2>&1 || echo 'DNS_BLOCKED'",
        ],
        limits: { maxRuntimeSec: 10, maxMemoryMb: 128 },
      });

      expect(result.stdout).toContain("DNS_BLOCKED");
    } finally {
      await cleanupWorkspace(workspace);
    }
  });
});
