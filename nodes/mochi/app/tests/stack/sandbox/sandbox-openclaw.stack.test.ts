// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-openclaw`
 * Purpose: Full-stack acceptance test proving OpenClaw gateway mode works end-to-end.
 * Scope: Tests gateway chat, secrets isolation, repo volume mount, workspace writability, and WS event isolation (cross-run). Does not test ephemeral container path or billing DB writes (see gateway-billing-callback.stack.test.ts).
 * Invariants:
 *   - Per SECRETS_HOST_ONLY: LITELLM_MASTER_KEY never enters gateway container
 *   - Per COST_AUTHORITY_IS_LITELLM: gateway billing via LiteLLM callback, not proxy audit log
 *   - Per WS_EVENT_CAUSALITY: concurrent sessions receive zero cross-run tokens (skipped; requires real LLM)
 * Side-effects: IO (HTTP to gateway, Docker exec for assertions)
 * Links: docs/spec/openclaw-sandbox-spec.md, src/adapters/server/sandbox/
 * @public
 */

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Gateway + LLM round-trip. Generous timeout for first-call session creation.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 15_000 });

import { LlmProxyManager } from "@/adapters/server/sandbox";
import {
  type GatewayAgentEvent,
  OpenClawGatewayClient,
} from "@/adapters/server/sandbox/openclaw-gateway-client";
import { SandboxGraphProvider } from "@/adapters/server/sandbox/sandbox-graph.provider";
import type { SandboxRunnerPort } from "@/ports";
import { serverEnv } from "@/shared/env/server";

import {
  execInContainer,
  makeGatewayRunRequest,
} from "../../_fixtures/sandbox/fixtures";

const {
  OPENCLAW_GATEWAY_URL: GATEWAY_URL,
  OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
} = serverEnv();
const GATEWAY_CONTAINER = "openclaw-gateway";
const PROXY_CONTAINER = "llm-proxy-openclaw";

/**
 * LiteLLM deployment hashes per model group (litellm_model_id).
 * These are SHA-256 hashes of the deployment config and are stable across restarts.
 * Derived from LiteLLM spend logs: GET /spend/logs → entries[].model_id + entries[].model_group
 * Source configs: litellm.test.config.yaml (test models → mock-llm backend)
 */
const LITELLM_MODEL_IDS: Record<string, string> = {
  "test-model":
    "cde092af6f4c69b3d3ac2e2f7dcf97a3279fa1c37d1f399951f5d7cc7c4bc511",
  "test-free-model":
    "c86e3ee3b6dc9be88ff9429c4e5583502c62d5d0cc87767095a5f52b260bb897",
  "test-paid-model":
    "4bc3010e9687ca1b5962c19db9bfbecdcbdf53d4248a2cdd0eebfd1a58420075",
};

/**
 * Extract litellm_model_id from LiteLLM spend/logs API.
 * Gateway audit log was removed (COST_AUTHORITY_IS_LITELLM) — query the source of truth directly.
 * @param runId - run_id embedded in x-litellm-spend-logs-metadata header
 * @param endUser - value of x-litellm-end-user-id header (maps to end_user in spend logs)
 */
async function extractModelId(runId: string, endUser: string): Promise<string> {
  const env = serverEnv();
  try {
    const url = new URL("/spend/logs", env.LITELLM_BASE_URL);
    url.searchParams.set("end_user", endUser);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}` },
    });
    if (!res.ok) return "-";

    const logs = (await res.json()) as Array<{
      model_id?: string;
      metadata?: { spend_logs_metadata?: { run_id?: string } };
    }>;

    const entry = logs.find(
      (l) => l.metadata?.spend_logs_metadata?.run_id === runId
    );
    return entry?.model_id && entry.model_id !== "-" ? entry.model_id : "-";
  } catch {
    return "-";
  }
}

function uniqueRunId(prefix = "gw-test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Collect all events from a gateway agent run into an array. */
async function collectEvents(
  gen: AsyncGenerator<GatewayAgentEvent>
): Promise<GatewayAgentEvent[]> {
  const events: GatewayAgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Check if a container exists and is running */
async function isContainerHealthy(
  docker: Docker,
  name: string
): Promise<boolean> {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return info.State.Running && info.State.Health?.Status === "healthy";
  } catch {
    return false;
  }
}

let client: OpenClawGatewayClient;
let docker: Docker;

describe("OpenClaw Gateway Full-Stack", () => {
  beforeAll(async () => {
    docker = new Docker();

    const [gatewayOk, proxyOk] = await Promise.all([
      isContainerHealthy(docker, GATEWAY_CONTAINER),
      isContainerHealthy(docker, PROXY_CONTAINER),
    ]);

    if (!gatewayOk || !proxyOk) {
      throw new Error(
        `OpenClaw gateway containers not running. ` +
          `Start with: pnpm sandbox:openclaw:up\n` +
          `  ${GATEWAY_CONTAINER}: ${gatewayOk ? "healthy" : "not found/unhealthy"}\n` +
          `  ${PROXY_CONTAINER}: ${proxyOk ? "healthy" : "not found/unhealthy"}`
      );
    }

    client = new OpenClawGatewayClient(GATEWAY_URL, GATEWAY_TOKEN);
  });

  afterAll(async () => {
    // Clean up any orphaned per-run proxy containers (from other test suites)
    if (docker) {
      await LlmProxyManager.cleanupSweep(docker).catch(() => {});
    }
  });

  // bug.0009: mock-llm SSE streaming incompatible with OpenClaw pi-ai agent runtime.
  // Real models work (verified with nemotron-nano-30b through full proxy stack).
  // Skipped until mock-llm compat is fixed or a local mock alternative is found.
  it.skip("gateway responds to agent call via WS", async () => {
    const runId = uniqueRunId();
    const sessionKey = `agent:main:test-billing:${runId}`;

    // Run agent and collect typed events
    const events = await collectEvents(
      client.runAgent({
        message: 'Say "hello from gateway" and nothing else.',
        sessionKey,
        outboundHeaders: {
          "x-litellm-end-user-id": "test-billing",
          "x-litellm-spend-logs-metadata": JSON.stringify({
            run_id: runId,
            graph_id: "sandbox:openclaw",
          }),
          "x-cogni-run-id": runId,
        },
        timeoutMs: 45_000,
      })
    );

    // Green path: no errors
    const errors = events.filter((e) => e.type === "chat_error");
    expect(errors).toHaveLength(0);

    // Green path: accepted with a runId
    const accepted = events.find((e) => e.type === "accepted") as
      | Extract<GatewayAgentEvent, { type: "accepted" }>
      | undefined;
    expect(accepted).toBeDefined();
    expect(accepted?.runId).toBeTruthy();

    // Green path: chat_final with real LLM content
    const chatFinal = events.find((e) => e.type === "chat_final") as
      | Extract<GatewayAgentEvent, { type: "chat_final" }>
      | undefined;
    expect(chatFinal).toBeDefined();
    expect(chatFinal?.text.length).toBeGreaterThan(0);
    // Must not be an error string masquerading as content
    expect(chatFinal?.text).not.toMatch(/Invalid model/i);
    expect(chatFinal?.text).not.toMatch(/No response from OpenClaw/i);
  });

  // Removed: "billing entries appear in proxy audit log" test.
  // Proxy billing reader deleted — billing now via LiteLLM callback (RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST).
  // Callback billing tested in gateway-billing-callback.stack.test.ts.

  it("can read LICENSE from workspace (repo mounted read-only)", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'cat /repo/current/LICENSE* 2>/dev/null | head -1 && echo "READ_OK" || echo "READ_FAIL"'
    );

    expect(output).toContain("READ_OK");
    expect(output).not.toContain("READ_FAIL");
    // LICENSE file should contain a recognizable license header
    expect(output).toMatch(/licen[sc]e|copyright|polyform/i);
  });

  it("/repo is mounted read-only at mount table level", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      "grep ' /repo ' /proc/mounts | grep -q 'ro,' && echo MOUNT_RO || echo MOUNT_BAD"
    );

    expect(output).toContain("MOUNT_RO");
    expect(output).not.toContain("MOUNT_BAD");
  });

  it("/repo/current/package.json is readable and identifies this repo", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'cat /repo/current/package.json 2>/dev/null | head -5 && echo "PKG_OK" || echo "PKG_FAIL"'
    );

    expect(output).toContain("PKG_OK");
    expect(output).toContain("cogni-template");
  });

  it("cannot write to LICENSE in workspace (repo is read-only)", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'echo "tampered" >> /repo/current/LICENSE 2>&1 && echo "WRITE_OK" || echo "WRITE_BLOCKED"'
    );

    expect(output).toContain("WRITE_BLOCKED");
    expect(output).not.toContain("WRITE_OK");
  });

  // tmpfs is mounted rw but owned by root; container runs as node. Compose config fix needed.
  it.skip("/workspace tmpfs is writable", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'touch /workspace/_test && rm /workspace/_test && echo "WS_WRITABLE" || echo "WS_READONLY"'
    );

    expect(output).toContain("WS_WRITABLE");
  });

  // WS_EVENT_CAUSALITY: two concurrent agent calls must never leak tokens across sessions.
  // Real models work (verified with nemotron-nano-30b). Skipped in CI — same mock-llm
  // limitation as bug.0009. Run locally with real LiteLLM model to validate.
  it.skip("cross-run isolation: two concurrent calls receive zero foreign tokens", async () => {
    // Two independent clients — each opens its own WS connection
    const clientA = new OpenClawGatewayClient(GATEWAY_URL, GATEWAY_TOKEN);
    const clientB = new OpenClawGatewayClient(GATEWAY_URL, GATEWAY_TOKEN);

    const runIdA = uniqueRunId("isolation-A");
    const runIdB = uniqueRunId("isolation-B");
    const sessionKeyA = `agent:main:test-isolation-a:${runIdA}`;
    const sessionKeyB = `agent:main:test-isolation-b:${runIdB}`;

    const makeHeaders = (runId: string, account: string) => ({
      "x-litellm-end-user-id": account,
      "x-litellm-spend-logs-metadata": JSON.stringify({
        run_id: runId,
        graph_id: "sandbox:openclaw",
      }),
      "x-cogni-run-id": runId,
    });

    // Fire both calls concurrently — gateway broadcasts all chat events to all WS clients
    const [eventsA, eventsB] = await Promise.all([
      collectEvents(
        clientA.runAgent({
          message: 'Respond with exactly: "ALPHA_RESPONSE"',
          sessionKey: sessionKeyA,
          outboundHeaders: makeHeaders(runIdA, "test-isolation-a"),
          timeoutMs: 45_000,
        })
      ),
      collectEvents(
        clientB.runAgent({
          message: 'Respond with exactly: "BRAVO_RESPONSE"',
          sessionKey: sessionKeyB,
          outboundHeaders: makeHeaders(runIdB, "test-isolation-b"),
          timeoutMs: 45_000,
        })
      ),
    ]);

    // Both must complete without errors
    const errorsA = eventsA.filter((e) => e.type === "chat_error");
    const errorsB = eventsB.filter((e) => e.type === "chat_error");
    expect(errorsA).toHaveLength(0);
    expect(errorsB).toHaveLength(0);

    // Both must have chat_final
    const finalA = eventsA.find((e) => e.type === "chat_final") as
      | Extract<GatewayAgentEvent, { type: "chat_final" }>
      | undefined;
    const finalB = eventsB.find((e) => e.type === "chat_final") as
      | Extract<GatewayAgentEvent, { type: "chat_final" }>
      | undefined;
    expect(finalA).toBeDefined();
    expect(finalB).toBeDefined();

    // Collect all text delivered to each client (deltas + final)
    const textA = eventsA
      .filter(
        (e): e is Extract<GatewayAgentEvent, { type: "text_delta" }> =>
          e.type === "text_delta"
      )
      .map((e) => e.text)
      .join("");
    const textB = eventsB
      .filter(
        (e): e is Extract<GatewayAgentEvent, { type: "text_delta" }> =>
          e.type === "text_delta"
      )
      .map((e) => e.text)
      .join("");

    // CRITICAL ISOLATION ASSERTIONS:
    // Client A must never see BRAVO content; Client B must never see ALPHA content.
    // Fail on the first foreign byte.
    expect(textA).not.toContain("BRAVO");
    expect(textB).not.toContain("ALPHA");
    expect(finalA?.text).not.toContain("BRAVO");
    expect(finalB?.text).not.toContain("ALPHA");

    // Positive check: each stream contains its own expected content
    // (LLMs may paraphrase, so check the final authoritative response)
    expect(finalA?.text.length).toBeGreaterThan(0);
    expect(finalB?.text.length).toBeGreaterThan(0);

    // No HEARTBEAT_OK in either stream
    expect(textA).not.toContain("HEARTBEAT_OK");
    expect(textB).not.toContain("HEARTBEAT_OK");
    expect(finalA?.text).not.toContain("HEARTBEAT_OK");
    expect(finalB?.text).not.toContain("HEARTBEAT_OK");
  });

  // bug.0051: extractModelId can't correlate gateway calls to LiteLLM spend logs
  // (spend_logs_metadata missing from gateway entries, end_user filter broken)
  it.skip("session model override: test-free-model reaches LiteLLM", async () => {
    const runId = uniqueRunId("model-free");
    const sessionKey = `agent:main:test-model-free:${runId}`;
    const outboundHeaders = {
      "x-litellm-end-user-id": "test-model-select",
      "x-litellm-spend-logs-metadata": JSON.stringify({
        run_id: runId,
        graph_id: "sandbox:openclaw",
      }),
      "x-cogni-run-id": runId,
    };

    // Patch session with model override BEFORE agent call
    await client.configureSession(
      sessionKey,
      outboundHeaders,
      "cogni/test-free-model"
    );

    // Run agent — should use the overridden model
    await collectEvents(
      client.runAgent({
        message: "Hello",
        sessionKey,
        outboundHeaders,
        timeoutMs: 45_000,
      })
    );

    // Assert ACTUAL model from LiteLLM spend/logs API.
    // litellm_model_id is a deployment hash stable across restarts.
    await new Promise((r) => setTimeout(r, 1000));
    const modelId = await extractModelId(
      runId,
      outboundHeaders["x-litellm-end-user-id"]
    );
    expect(modelId).toBe(LITELLM_MODEL_IDS["test-free-model"]);
    expect(modelId).not.toBe(LITELLM_MODEL_IDS["test-model"]); // not the default
  });

  // bug.0051
  it.skip("session model override: test-paid-model reaches LiteLLM", async () => {
    const runId = uniqueRunId("model-paid");
    const sessionKey = `agent:main:test-model-paid:${runId}`;
    const outboundHeaders = {
      "x-litellm-end-user-id": "test-model-select",
      "x-litellm-spend-logs-metadata": JSON.stringify({
        run_id: runId,
        graph_id: "sandbox:openclaw",
      }),
      "x-cogni-run-id": runId,
    };

    await client.configureSession(
      sessionKey,
      outboundHeaders,
      "cogni/test-paid-model"
    );

    await collectEvents(
      client.runAgent({
        message: "Hello",
        sessionKey,
        outboundHeaders,
        timeoutMs: 45_000,
      })
    );

    await new Promise((r) => setTimeout(r, 1000));
    const modelId = await extractModelId(
      runId,
      outboundHeaders["x-litellm-end-user-id"]
    );
    expect(modelId).toBe(LITELLM_MODEL_IDS["test-paid-model"]);
    expect(modelId).not.toBe(LITELLM_MODEL_IDS["test-model"]); // not the default
  });

  // bug.0051
  it.skip("provider-level model selection: GraphRunRequest.model reaches LiteLLM", async () => {
    const req = makeGatewayRunRequest({
      runId: uniqueRunId("provider-model"),
      modelRef: { providerKey: "platform", modelId: "cogni/test-free-model" },
      caller: {
        billingAccountId: "test-provider-model",
        virtualKeyId: "test-vk",
        requestId: "provider-model",
        traceId: "provider-model",
        userId: "test-user",
      },
    });

    // Stub runner — gateway mode never calls runOnce()
    const stubRunner: SandboxRunnerPort = {
      runOnce: () => {
        throw new Error("runOnce should not be called in gateway mode");
      },
    };

    const provider = new SandboxGraphProvider(stubRunner, client);

    const { stream } = provider.runGraph(req);

    // Drain the stream — don't assert on success/errors (mock-llm compat issues per bug.0009).
    // The LLM call still hits the proxy and gets logged regardless of agent-level errors.
    for await (const _event of stream) {
      /* drain */
    }

    // CRITICAL: The model that actually hit LiteLLM must be test-free-model,
    // NOT the gateway default (test-model). This fails until createGatewayExecution()
    // calls configureSession() with the model from GraphRunRequest.
    await new Promise((r) => setTimeout(r, 1000));
    const modelId = await extractModelId(
      req.runId,
      req.caller.billingAccountId
    );
    expect(modelId).toBe(LITELLM_MODEL_IDS["test-free-model"]);
    expect(modelId).not.toBe(LITELLM_MODEL_IDS["test-model"]);
  });

  it("gateway container does not have LITELLM_MASTER_KEY in env", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'env | grep -q LITELLM_MASTER_KEY && echo "LEAKED" || echo "SAFE"'
    );

    expect(output).toContain("SAFE");
    expect(output).not.toContain("LEAKED");
  });
});
