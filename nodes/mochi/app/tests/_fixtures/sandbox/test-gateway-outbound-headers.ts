#!/usr/bin/env npx tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/sandbox/test-gateway-outbound-headers`
 * Purpose: Manual validation script for OpenClaw gateway outboundHeaders patch.
 * Scope: Runs against already-running oc-gateway + oc-echo containers. NOT a vitest test.
 * Invariants: Requires running oc-gateway + oc-echo containers.
 * Side-effects: IO (WebSocket connections, child_process exec for Docker log reads)
 * Links: docs/research/openclaw-gateway-header-injection.md
 * Usage: npx tsx tests/_fixtures/sandbox/test-gateway-outbound-headers.ts
 * Prerequisites: oc-gateway (openclaw-outbound-headers:latest, port 18789) + oc-echo (port 9998) running
 * @internal
 */

import { execSync } from "node:child_process";
import { OpenClawGatewayClient } from "./openclaw-gateway-client";

const GW_URL = "ws://127.0.0.1:18789";
const GW_TOKEN = "test-token";

// ─────────────────────────────────────────────────────────────────────────────
// Echo server helpers
// ─────────────────────────────────────────────────────────────────────────────

function clearEchoCaptures(): void {
  execSync("docker exec oc-echo sh -c '> /tmp/captured.jsonl'");
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function readEchoCaptures(): CapturedRequest[] {
  const raw = execSync("docker exec oc-echo cat /tmp/captured.jsonl")
    .toString()
    .trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as CapturedRequest);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Basic outboundHeaders via agent call
// ─────────────────────────────────────────────────────────────────────────────

async function testBasicOutboundHeaders(): Promise<void> {
  console.log("\n=== Test 1: Basic outboundHeaders via agent call ===");

  clearEchoCaptures();

  const client = new OpenClawGatewayClient();
  try {
    console.log("  Connecting...");
    await client.connect({ url: GW_URL, token: GW_TOKEN });
    console.log("  Connected OK");

    console.log("  Sending agent call with outboundHeaders...");
    const response = await client.agent({
      message: "say hello",
      sessionKey: "agent:main:test-basic-headers",
      outboundHeaders: {
        "x-litellm-end-user-id": "tenant-42",
        "x-litellm-spend-logs-metadata": JSON.stringify({
          runId: "run-abc",
          graphId: "graph-xyz",
        }),
      },
    });

    console.log(`  Agent response ok=${response.ok}`);

    // Wait a moment for echo server to capture
    await new Promise((r) => setTimeout(r, 500));

    const captures = readEchoCaptures();
    assert(
      captures.length >= 1,
      `Expected >=1 capture, got ${captures.length}`
    );

    const last = captures[captures.length - 1];
    console.log("  Captured headers:", JSON.stringify(last.headers, null, 2));

    // Check static header
    assert(
      last.headers["x-static-provider-header"] === "from-config",
      "Static provider header missing"
    );

    // Check dynamic outbound headers
    assert(
      last.headers["x-litellm-end-user-id"] === "tenant-42",
      `Expected x-litellm-end-user-id=tenant-42, got ${last.headers["x-litellm-end-user-id"]}`
    );
    assert(
      last.headers["x-litellm-spend-logs-metadata"] !== undefined,
      "x-litellm-spend-logs-metadata missing"
    );

    const meta = JSON.parse(last.headers["x-litellm-spend-logs-metadata"]);
    assert(
      meta.runId === "run-abc",
      `Expected runId=run-abc, got ${meta.runId}`
    );

    console.log("  PASS: outboundHeaders flow to outbound LLM calls");
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Concurrent session isolation
// ─────────────────────────────────────────────────────────────────────────────

async function testConcurrentIsolation(): Promise<void> {
  console.log("\n=== Test 2: Concurrent session isolation ===");

  clearEchoCaptures();

  const clientA = new OpenClawGatewayClient();
  const clientB = new OpenClawGatewayClient();

  try {
    // Connect both clients
    console.log("  Connecting client A...");
    await clientA.connect({ url: GW_URL, token: GW_TOKEN });
    console.log("  Connecting client B...");
    await clientB.connect({ url: GW_URL, token: GW_TOKEN });
    console.log("  Both connected OK");

    // Fire agent calls concurrently with different headers
    console.log("  Sending concurrent agent calls...");
    const [respA, respB] = await Promise.all([
      clientA.agent({
        message: "say A",
        sessionKey: "agent:main:isolation-A",
        outboundHeaders: {
          "x-litellm-end-user-id": "tenant-A",
          "x-session-marker": "session-A",
        },
      }),
      clientB.agent({
        message: "say B",
        sessionKey: "agent:main:isolation-B",
        outboundHeaders: {
          "x-litellm-end-user-id": "tenant-B",
          "x-session-marker": "session-B",
        },
      }),
    ]);

    console.log(`  Response A ok=${respA.ok}, Response B ok=${respB.ok}`);

    await new Promise((r) => setTimeout(r, 500));

    const captures = readEchoCaptures();
    assert(
      captures.length >= 2,
      `Expected >=2 captures, got ${captures.length}`
    );

    // Check that each capture has its own session's headers
    const tenantHeaders = captures.map(
      (c) => c.headers["x-litellm-end-user-id"]
    );
    const markerHeaders = captures.map((c) => c.headers["x-session-marker"]);

    console.log("  Tenant headers:", tenantHeaders);
    console.log("  Marker headers:", markerHeaders);

    assert(tenantHeaders.includes("tenant-A"), "Missing tenant-A in captures");
    assert(tenantHeaders.includes("tenant-B"), "Missing tenant-B in captures");

    // Verify no cross-contamination: each capture should have matching tenant + marker
    for (const capture of captures) {
      const tenant = capture.headers["x-litellm-end-user-id"];
      const marker = capture.headers["x-session-marker"];
      if (tenant === "tenant-A") {
        assert(
          marker === "session-A",
          `Cross-contamination: tenant-A has marker ${marker}`
        );
      } else if (tenant === "tenant-B") {
        assert(
          marker === "session-B",
          `Cross-contamination: tenant-B has marker ${marker}`
        );
      }
    }

    console.log("  PASS: No cross-contamination between concurrent sessions");
  } finally {
    clientA.close();
    clientB.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Clear outboundHeaders via sessions.patch(null)
// ─────────────────────────────────────────────────────────────────────────────

async function testClearOutboundHeaders(): Promise<void> {
  console.log("\n=== Test 3: Clear outboundHeaders via sessions.patch ===");

  const client = new OpenClawGatewayClient();

  try {
    console.log("  Connecting...");
    await client.connect({ url: GW_URL, token: GW_TOKEN });

    // Step 1: Set headers via agent call
    console.log("  Step 1: Setting outboundHeaders via agent call...");
    clearEchoCaptures();
    await client.agent({
      message: "first call with headers",
      sessionKey: "agent:main:clear-test",
      outboundHeaders: {
        "x-litellm-end-user-id": "tenant-clear-test",
        "x-billing-tag": "should-disappear",
      },
    });

    await new Promise((r) => setTimeout(r, 500));
    const before = readEchoCaptures();
    assert(before.length >= 1, "No captures from first call");
    assert(
      before[before.length - 1].headers["x-billing-tag"] === "should-disappear",
      "x-billing-tag not set in first call"
    );
    console.log("  Headers present on first call: OK");

    // Step 2: Clear headers via sessions.patch
    console.log("  Step 2: Clearing outboundHeaders via sessions.patch...");
    const patchResp = await client.sessionsPatch({
      sessionKey: "agent:main:clear-test",
      outboundHeaders: null,
    });
    console.log(`  sessions.patch response ok=${patchResp.ok}`);

    // Step 3: Fire another agent call on same session — headers should be gone
    console.log("  Step 3: Sending agent call after clear...");
    clearEchoCaptures();
    await client.agent({
      message: "second call without headers",
      sessionKey: "agent:main:clear-test",
    });

    await new Promise((r) => setTimeout(r, 500));
    const after = readEchoCaptures();
    assert(after.length >= 1, "No captures from second call");

    const lastAfter = after[after.length - 1];
    assert(
      lastAfter.headers["x-billing-tag"] === undefined,
      `x-billing-tag still present after clear: ${lastAfter.headers["x-billing-tag"]}`
    );
    assert(
      lastAfter.headers["x-litellm-end-user-id"] === undefined,
      `x-litellm-end-user-id still present after clear: ${lastAfter.headers["x-litellm-end-user-id"]}`
    );

    // Static headers should still be there
    assert(
      lastAfter.headers["x-static-provider-header"] === "from-config",
      "Static provider header should survive clear"
    );

    console.log("  PASS: outboundHeaders cleared, static headers preserved");
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("OpenClaw Gateway outboundHeaders Patch Validation");
  console.log("=".repeat(50));
  console.log(`Gateway: ${GW_URL}`);
  console.log(`Token: ${GW_TOKEN}`);

  const results: { name: string; pass: boolean; error?: string }[] = [];

  for (const [name, fn] of [
    ["Basic outboundHeaders", testBasicOutboundHeaders],
    ["Concurrent isolation", testConcurrentIsolation],
    ["Clear outboundHeaders", testClearOutboundHeaders],
  ] as const) {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL: ${msg}`);
      results.push({ name, pass: false, error: msg });
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("RESULTS:");
  for (const r of results) {
    console.log(
      `  ${r.pass ? "PASS" : "FAIL"}: ${r.name}${r.error ? ` — ${r.error}` : ""}`
    );
  }

  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main();
