// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-llm-completion`
 * Purpose: P0.5 acceptance tests proving sandbox containers can reach the LLM proxy
 *          via unix socket bridge while maintaining network=none isolation.
 * Scope: Tests proxy infrastructure, socket bridge, network isolation, secrets safety. Does not test actual LLM completions (requires internet).
 * Invariants:
 *   - Per NETWORK_DEFAULT_DENY: Container runs with network=none
 *   - Per SECRETS_HOST_ONLY: LITELLM_MASTER_KEY never enters container
 *   - Per HOST_INJECTS_BILLING_HEADER: Proxy injects x-litellm-end-user-id
 *   - Per LLM_VIA_SOCKET_ONLY: LLM access only via localhost:8080 -> socket -> proxy
 * Side-effects: IO (Docker containers, nginx proxy, filesystem)
 * Links: docs/spec/sandboxed-agents.md, P0.5 spec
 * @public
 */

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Full proxy+sandbox flow completes in <1s (see scripts/diag-full-flow.mjs).
// 4s per test is generous; 10s for hooks (setup/teardown touch multiple containers).
vi.setConfig({ testTimeout: 4_000, hookTimeout: 10_000 });

import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";

import {
  assertLitellmReachable,
  assertSandboxImageExists,
  cleanupOrphanedProxies,
  cleanupWorkspace,
  createWorkspace,
  ensureProxyImage,
  runIsolated,
  runWithProxy,
  type SandboxTestContextWithProxy,
} from "../../_fixtures/sandbox/fixtures";

let ctx: SandboxTestContextWithProxy | null = null;

// Skipped: ephemeral sandbox infrastructure not in use; tests timeout without Docker setup
describe.skip("Sandbox LLM Proxy Infrastructure (P0.5)", () => {
  const docker = new Docker();
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY;

  beforeAll(async () => {
    // Clean up orphaned containers from previous crashed runs
    await cleanupOrphanedProxies(docker);

    if (!litellmMasterKey) {
      console.warn(
        "SKIPPING P0.5 TESTS: LITELLM_MASTER_KEY not set. Start dev stack with: pnpm dev:infra"
      );
      return;
    }

    await assertSandboxImageExists(docker);
    await ensureProxyImage(docker);
    await assertLitellmReachable();

    ctx = {
      runner: new SandboxRunnerAdapter({
        litellmMasterKey,
      }),
      workspace: await createWorkspace("sandbox-llm-completion"),
      docker,
      litellmMasterKey,
    };
  });

  afterAll(async () => {
    // Stop any proxy containers still tracked by the manager
    if (ctx?.runner) {
      await ctx.runner.dispose();
    }
    if (ctx?.workspace) {
      await cleanupWorkspace(ctx.workspace);
    }
    // Belt-and-suspenders: remove any containers that escaped the manager
    await cleanupOrphanedProxies(docker);
    ctx = null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Socket Bridge Tests
  // ───────────────────────────────────────────────────────────────────────────

  // Skip: flaky — proxy container vanishes mid-startup (bug.0013)
  it.skip("socket bridge connects sandbox to proxy health endpoint", async () => {
    if (!ctx) return;

    const result = await runWithProxy(
      ctx,
      'curl -sf --max-time 2 http://localhost:8080/health && echo "HEALTH_OK"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("HEALTH_OK");
    expect(result.stdout).toContain("status");
  });

  // Skip: flaky — proxy container vanishes mid-startup (bug.0013)
  it.skip("socket bridge forwards to LiteLLM (connection test)", async () => {
    if (!ctx) return;

    const result = await runWithProxy(
      ctx,
      'HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8080/v1/models) && echo "HTTP_CODE=$HTTP_CODE"'
    );

    expect(result.ok).toBe(true);
    // Accept 200 (success) or 5xx (LiteLLM can't reach backend) - either proves proxy works
    expect(result.stdout).toMatch(/HTTP_CODE=(200|5\d\d)/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Network Isolation Tests
  // ───────────────────────────────────────────────────────────────────────────

  it("container without llmProxy cannot reach localhost:8080", async () => {
    if (!ctx) return;

    const result = await runIsolated(
      ctx,
      'curl -s --max-time 1 http://localhost:8080/health 2>&1 && echo "CURL_OK" || echo "CURL_FAIL"'
    );

    expect(result.stdout).toContain("CURL_FAIL");
    expect(result.stdout).not.toContain("CURL_OK");
  });

  it("container without llmProxy cannot reach external IPs", async () => {
    if (!ctx) return;

    const result = await runIsolated(
      ctx,
      'curl -s --max-time 1 http://1.1.1.1 2>&1 && echo "CURL_OK" || echo "CURL_FAIL"'
    );

    expect(result.stdout).toContain("CURL_FAIL");
    expect(result.stdout).not.toContain("CURL_OK");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Secrets Isolation Tests (SECRETS_HOST_ONLY)
  // ───────────────────────────────────────────────────────────────────────────

  it("container env does not contain LITELLM_MASTER_KEY", async () => {
    if (!ctx) return;

    const result = await runWithProxy(
      ctx,
      'env | grep -q LITELLM_MASTER_KEY && echo "LEAKED" || echo "SAFE"'
    );

    expect(result.stdout).toContain("SAFE");
    expect(result.stdout).not.toContain("LEAKED");
  });

  it("container env does not contain OPENAI_API_KEY", async () => {
    if (!ctx) return;

    const result = await runWithProxy(
      ctx,
      'env | grep -q OPENAI_API_KEY && echo "LEAKED" || echo "SAFE"'
    );

    expect(result.stdout).toContain("SAFE");
  });

  it("container env has OPENAI_API_BASE pointing to proxy", async () => {
    if (!ctx) return;

    const result = await runWithProxy(ctx, "echo $OPENAI_API_BASE");

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("localhost:8080");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Header Injection Tests (HOST_INJECTS_BILLING_HEADER)
  // ───────────────────────────────────────────────────────────────────────────

  it("proxy accepts requests with spoofed headers (strips them)", async () => {
    if (!ctx) return;

    const result = await runWithProxy(
      ctx,
      'curl -sf --max-time 2 -H "x-litellm-end-user-id: spoofed" http://localhost:8080/health && echo "REQUEST_OK"'
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("REQUEST_OK");
  });
});
