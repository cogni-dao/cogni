// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-litellm`
 * Purpose: P0.5a acceptance tests proving sandbox containers can reach LiteLLM via internal network
 *          while remaining isolated from the public internet.
 * Scope: Tests LiteLLM reachability, network isolation (route, DNS, IP). Does not test LLM completions.
 * Invariants:
 *   - Containers on sandbox-internal can only reach services on the same network
 *   - No public internet access (internal: true prevents external gateway)
 *   - No Docker socket access (container escape prevention)
 * Side-effects: IO (Docker containers, filesystem)
 * Links: docs/spec/sandboxed-agents.md, P0.5a spec
 * @public
 */

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";

import {
  assertInternalNetworkExists,
  assertSandboxImageExists,
  cleanupWorkspace,
  createWorkspace,
  runOnInternalNetwork,
  type SandboxTestContext,
} from "../../_fixtures/sandbox/fixtures";

let ctx: SandboxTestContext | null = null;

describe("Sandbox LiteLLM Reachability (P0.5a)", () => {
  const docker = new Docker();

  beforeAll(async () => {
    await assertSandboxImageExists(docker);
    await assertInternalNetworkExists(docker);

    ctx = {
      runner: new SandboxRunnerAdapter(),
      workspace: await createWorkspace("sandbox-litellm"),
      docker,
    };
  });

  afterAll(async () => {
    if (ctx?.workspace) {
      await cleanupWorkspace(ctx.workspace);
    }
    ctx = null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LiteLLM Connectivity Tests
  // ───────────────────────────────────────────────────────────────────────────

  it("container can reach LiteLLM health endpoint (HTTP 200)", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://litellm:4000/health/liveliness) && echo "HTTP_CODE=$HTTP_CODE"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("HTTP_CODE=200");
  });

  it("container CAN resolve litellm DNS (internal network works)", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'getent hosts litellm && echo "DNS_OK" || echo "DNS_FAIL"'
    );

    expect(result.stdout).toContain("DNS_OK");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Network Isolation Tests
  // ───────────────────────────────────────────────────────────────────────────

  it("container has no default route (internal network isolation)", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'ip route show default 2>/dev/null | grep -q default && echo "HAS_ROUTE" || echo "NO_ROUTE"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("NO_ROUTE");
    expect(result.stdout).not.toContain("HAS_ROUTE");
  });

  it("container cannot resolve external DNS", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'getent hosts example.com 2>&1 && echo "DNS_OK" || echo "DNS_FAIL"'
    );

    expect(result.stdout).toContain("DNS_FAIL");
    expect(result.stdout).not.toContain("DNS_OK");
  });

  it("container cannot reach external IP directly", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'curl -s --max-time 1 http://1.1.1.1 2>&1 && echo "CURL_OK" || echo "CURL_FAIL"'
    );

    expect(result.stdout).toContain("CURL_FAIL");
    expect(result.stdout).not.toContain("CURL_OK");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Security Tests
  // ───────────────────────────────────────────────────────────────────────────

  it("container cannot access Docker socket", async () => {
    if (!ctx) return;

    const result = await runOnInternalNetwork(
      ctx,
      'ls -la /var/run/docker.sock 2>&1 && echo "SOCKET_FOUND" || echo "NO_SOCKET"'
    );

    expect(result.stdout).toContain("NO_SOCKET");
    expect(result.stdout).not.toContain("SOCKET_FOUND");
  });
});
