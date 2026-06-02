// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/gateway-billing-callback.stack`
 * Purpose: E2E test proving LiteLLM generic_api callback → billing ingest → charge_receipts with cost > 0.
 * Scope: Exercises the full callback billing pipeline from gateway agent call through LiteLLM generic_api callback to charge_receipts DB rows. Does not test ephemeral sandbox billing, proxy audit log path, or InProc billing.
 * Invariants:
 *   - CALLBACK_COST_GT_ZERO: charge_receipts.response_cost_usd > 0 for paid model calls
 *   - CALLBACK_AUTHENTICATED: LiteLLM sends Bearer token via GENERIC_LOGGER_HEADERS
 *   - COST_AUTHORITY_IS_LITELLM: response_cost in callback is the authoritative cost source
 * Side-effects: IO (gateway WS, LiteLLM callback HTTP, database writes)
 * Notes:
 *   SKIPPED — requires mock-llm to be compatible with OpenClaw agent runtime (bug.0009).
 *   The mock-llm SSE streaming format is incompatible with the pi-ai runtime used by OpenClaw,
 *   so gateway agent calls fail before LiteLLM can fire the generic_api callback.
 *   When mock-llm compat is fixed, unskip this test — it's the only thing that proves
 *   callback-driven billing actually works end-to-end.
 *
 *   To run manually with a real model (e.g. gemini-2.5-flash):
 *     1. Configure litellm.config.yaml with a real provider key
 *     2. Start full dev stack: pnpm dev:stack
 *     3. Run: pnpm test:stack -- tests/stack/sandbox/gateway-billing-callback.stack.test.ts
 *
 * Links: docs/spec/billing-ingest.md, src/app/api/internal/billing/ingest/route.ts
 * @public
 */

import Docker from "dockerode";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 15_000 });

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  makeGatewayRunRequest,
  uniqueRunId,
} from "@tests/_fixtures/sandbox/fixtures";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { LlmProxyManager } from "@/adapters/server/sandbox";
import {
  type GatewayAgentEvent,
  OpenClawGatewayClient,
} from "@/adapters/server/sandbox/openclaw-gateway-client";
import { SandboxGraphProvider } from "@/adapters/server/sandbox/sandbox-graph.provider";
import type { SandboxRunnerPort } from "@/ports";
import { chargeReceipts, llmChargeDetails, users } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server";

const {
  OPENCLAW_GATEWAY_URL: GATEWAY_URL,
  OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
} = serverEnv();
const GATEWAY_CONTAINER = "openclaw-gateway";
const PROXY_CONTAINER = "llm-proxy-openclaw";

/** Max time to wait for LiteLLM generic_api callback to arrive and be processed. */
const CALLBACK_SETTLE_MS = 5_000;
const CALLBACK_POLL_INTERVAL_MS = 500;

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

async function collectEvents(
  gen: AsyncGenerator<GatewayAgentEvent>
): Promise<GatewayAgentEvent[]> {
  const events: GatewayAgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Poll DB for a charge_receipt with the given runId and non-null cost.
 * LiteLLM fires the callback asynchronously after stream completion,
 * so we need to poll rather than assert immediately.
 */
async function waitForCallbackReceipt(
  runId: string,
  maxWaitMs = CALLBACK_SETTLE_MS
): Promise<typeof chargeReceipts.$inferSelect | null> {
  const db = getSeedDb();
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    // Look for a receipt with actual cost data (not the $0 proxy-path receipt)
    const withCost = rows.find(
      (r) => r.responseCostUsd !== null && Number(r.responseCostUsd) > 0
    );
    if (withCost) return withCost;

    await new Promise((r) => setTimeout(r, CALLBACK_POLL_INTERVAL_MS));
  }

  return null;
}

let client: OpenClawGatewayClient;
let docker: Docker;

describe("Gateway Billing Callback E2E", () => {
  let testActor: TestActor;

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
    if (docker) {
      await LlmProxyManager.cleanupSweep(docker).catch(() => {});
    }
  });

  beforeEach(async () => {
    const db = getSeedDb();
    testActor = await seedTestActor(db);
  });

  afterEach(async () => {
    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, testActor.user.id));
  });

  // SKIPPED: bug.0009 — mock-llm SSE format incompatible with OpenClaw pi-ai runtime.
  // Gateway agent calls fail before LiteLLM can fire the generic_api callback.
  // This test is CRITICAL for billing correctness — unskip when mock-llm compat is resolved.
  //
  // What this test proves when unskipped:
  //   1. LiteLLM generic_api callback fires after streaming completion
  //   2. GENERIC_LOGGER_ENDPOINT is reachable from the litellm container
  //   3. BILLING_INGEST_TOKEN auth succeeds
  //   4. charge_receipts row has response_cost_usd > 0
  //   5. llm_charge_details row is linked with correct model
  //   6. chargedCredits > 0 (not the $0 from the broken proxy path)
  it.skip("callback creates charge_receipt with cost > 0 after gateway streaming call", async () => {
    const runId = uniqueRunId("billing-cb");

    const stubRunner: SandboxRunnerPort = {
      runOnce: () => {
        throw new Error("runOnce should not be called in gateway mode");
      },
    };

    const provider = new SandboxGraphProvider(stubRunner, client);

    const req = makeGatewayRunRequest({
      runId,
      modelRef: { providerKey: "platform", modelId: "cogni/test-paid-model" },
      caller: {
        billingAccountId: testActor.billingAccountId,
        virtualKeyId: testActor.virtualKeyId,
        requestId: runId,
        traceId: runId,
        userId: testActor.user.id,
      },
    });

    // Run the gateway agent call — drains the stream
    const { stream } = provider.runGraph(req);
    for await (const _event of stream) {
      /* drain */
    }

    // Wait for LiteLLM generic_api callback to arrive asynchronously
    const receipt = await waitForCallbackReceipt(runId);

    // ── CRITICAL ASSERTIONS ──────────────────────────────────────────────
    // These are the assertions that NO existing test makes.
    // If these pass, callback-driven billing is working end-to-end.

    expect(receipt).not.toBeNull();
    const r = receipt as NonNullable<typeof receipt>;
    expect(Number(r.responseCostUsd)).toBeGreaterThan(0);
    expect(r.chargedCredits).toBeGreaterThan(0n);
    expect(r.billingAccountId).toBe(testActor.billingAccountId);
    expect(r.sourceSystem).toBe("litellm");

    // Verify linked llm_charge_details
    const db = getSeedDb();
    const details = await db
      .select()
      .from(llmChargeDetails)
      .where(eq(llmChargeDetails.chargeReceiptId, r.id));

    expect(details).toHaveLength(1);
    const d = details[0] as NonNullable<(typeof details)[0]>;
    expect(d.model).toBeTruthy();
    expect(d.graphId).toBe("sandbox:openclaw");
  });

  // Variant: test the callback flow via direct WebSocket client (lower-level, same billing assertion)
  it.skip("callback billing via direct WS client produces cost > 0", async () => {
    const runId = uniqueRunId("billing-ws");
    const sessionKey = `agent:main:${testActor.billingAccountId}:${runId}`;

    await collectEvents(
      client.runAgent({
        message: "Hello",
        sessionKey,
        outboundHeaders: {
          "x-litellm-end-user-id": testActor.billingAccountId,
          "x-litellm-spend-logs-metadata": JSON.stringify({
            run_id: runId,
            graph_id: "sandbox:openclaw",
          }),
          "x-cogni-run-id": runId,
        },
        timeoutMs: 45_000,
      })
    );

    const receipt = await waitForCallbackReceipt(runId);

    expect(receipt).not.toBeNull();
    const r = receipt as NonNullable<typeof receipt>;
    expect(Number(r.responseCostUsd)).toBeGreaterThan(0);
    expect(r.chargedCredits).toBeGreaterThan(0n);
    expect(r.billingAccountId).toBe(testActor.billingAccountId);
  });
});
