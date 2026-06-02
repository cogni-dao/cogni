// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-llm-roundtrip-billing`
 * Purpose: Acceptance test proving sandbox billing pipeline end-to-end from proxy audit log through charge_receipts DB row.
 * Scope: Full LLM round-trip (agent → proxy → LiteLLM → mock backend) with billing entry + DB assertions. Does not test graph execution pipeline or billing reconciliation.
 * Invariants:
 *   - Per REAL_PROXY_MOCK_BACKEND: LiteLLM routes test models to mock-openai-api
 *   - Per SECRETS_HOST_ONLY: LITELLM_MASTER_KEY never enters sandbox container
 *   - Per HOST_INJECTS_BILLING_HEADER: Proxy injects x-litellm-end-user-id
 *   - Per LLM_VIA_SOCKET_ONLY: LLM access only via localhost:8080 -> socket -> proxy
 *   - Per PROXY_DRIVEN_BILLING: Billing data (callId + cost) captured from proxy audit log, not agent stdout
 *   - Per USAGE_UNIT_IS_LITELLM_CALL_ID: charge_receipts.litellm_call_id matches audit log exactly
 * Side-effects: IO (Docker containers, nginx proxy, filesystem, database writes)
 * Links: docs/SANDBOXED_AGENTS.md, docs/SYSTEM_TEST_ARCHITECTURE.md
 * @public
 */

import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Full proxy+sandbox+LLM round-trip: proxy start (~1s) + LLM call (~1-2s) + teardown.
// 15s per test (DB write adds latency); 15s for hooks (multiple container operations).
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

import type { GraphId, RunContext, UsageFact } from "@cogni/ai-core";
import { UsageFactStrictSchema } from "@cogni/ai-core";
import type { UserId } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor } from "@tests/_fixtures/stack/seed";
import { UserDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";
import { commitUsageFact } from "@/features/ai/services/billing";
import { chargeReceipts, llmChargeDetails } from "@/shared/db/schema";
import { makeLogger } from "@/shared/observability";

import {
  assertLitellmReachable,
  assertSandboxImageExists,
  cleanupOrphanedProxies,
  cleanupWorkspace,
  createWorkspace,
  ensureProxyImage,
  runAgentWithLlm,
  SANDBOX_TEST_MODELS,
  type SandboxTestContextWithProxy,
} from "../../_fixtures/sandbox/fixtures";

const log = makeLogger({ component: "sandbox-billing-test" });

let ctx: SandboxTestContextWithProxy | null = null;

describe("Sandbox LLM Round-Trip Billing", () => {
  const docker = new Docker();
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY;

  beforeAll(async () => {
    await cleanupOrphanedProxies(docker);

    if (!litellmMasterKey) {
      console.warn(
        "SKIPPING: LITELLM_MASTER_KEY not set. Start dev stack with: pnpm dev:infra"
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
      workspace: await createWorkspace("sandbox-full-llm"),
      docker,
      litellmMasterKey,
    };
  });

  afterAll(async () => {
    if (ctx?.runner) {
      await ctx.runner.dispose();
    }
    if (ctx?.workspace) {
      await cleanupWorkspace(ctx.workspace);
    }
    await cleanupOrphanedProxies(docker);
    ctx = null;
  });

  // Skip: flaky — proxy container vanishes mid-startup (bug.0013)
  it.skip("proxy audit log captures billing data and commits to charge_receipts", async () => {
    if (!ctx) return;

    // 1. Run sandbox agent through full proxy chain
    const { result, envelope } = await runAgentWithLlm(ctx, {
      messages: [{ role: "user", content: "Say hello." }],
      model: SANDBOX_TEST_MODELS.default,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(envelope.payloads).toHaveLength(1);
    expect(envelope.payloads[0]?.text).toBeTruthy();
    expect(envelope.meta.error).toBeNull();

    // 2. Verify proxy captured billing data (1 LLM call = 1 entry)
    expect(result.proxyBillingEntries).toBeDefined();
    expect(result.proxyBillingEntries?.length).toBe(1);
    const entry = result.proxyBillingEntries?.[0];
    expect(entry).toBeDefined();
    expect(entry?.litellmCallId).toBeTruthy();
    expect(typeof entry?.costUsd).toBe("number");
    expect(entry?.costUsd).toBeGreaterThan(0);

    // 3. Construct UsageFact exactly as SandboxGraphProvider does (sandbox-graph.provider.ts:375-386)
    const runId = randomUUID();
    const attempt = 0;
    const fact: UsageFact = {
      runId,
      attempt,
      source: "litellm",
      executorType: "sandbox",
      billingAccountId: "will-be-replaced", // placeholder for schema validation
      virtualKeyId: "will-be-replaced",
      graphId: "sandbox:agent" as GraphId,
      model: SANDBOX_TEST_MODELS.default,
      usageUnitId: entry?.litellmCallId ?? "",
      ...(entry?.costUsd !== undefined && { costUsd: entry.costUsd }),
    };

    // 4. Validate with strict schema (same validation RunEventRelay applies)
    //    If this fails, the relay would reject the fact and billing breaks.
    const validation = UsageFactStrictSchema.safeParse(fact);
    expect(validation.success).toBe(true);

    // 5. Seed test actor and commit to DB (same as RunEventRelay → commitUsageFact)
    const db = getSeedDb();
    const actor = await seedTestActor(db);

    const realFact: UsageFact = {
      ...fact,
      billingAccountId: actor.billingAccountId,
      virtualKeyId: actor.virtualKeyId,
    };
    const runContext: RunContext = {
      runId,
      attempt,
      ingressRequestId: runId,
    };
    const accountService = new UserDrizzleAccountService(
      db,
      actor.user.id as UserId
    );

    await commitUsageFact(realFact, runContext, accountService, log);

    // 6. Verify charge_receipts row — DB value must match audit log exactly
    const receipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];

    // litellm_call_id in DB must exactly match the proxy audit log value
    expect(receipt?.litellmCallId).toBe(entry?.litellmCallId);
    expect(receipt?.sourceSystem).toBe("litellm");
    expect(receipt?.sourceReference).toBe(
      `${runId}/${attempt}/${entry?.litellmCallId}`
    );
    expect(receipt?.chargedCredits).toBeGreaterThan(0n);
    expect(receipt?.chargeReason).toBe("llm_usage");

    // 7. Verify linked llm_charge_details row
    const receiptId = receipt?.id;
    if (!receiptId) throw new Error("Receipt missing id");

    const details = await db
      .select()
      .from(llmChargeDetails)
      .where(eq(llmChargeDetails.chargeReceiptId, receiptId));

    expect(details).toHaveLength(1);
    const detail = details[0];
    expect(detail?.model).toBe(SANDBOX_TEST_MODELS.default);
    expect(detail?.graphId).toBe("sandbox:agent");
    expect(detail?.providerCallId).toBe(entry?.litellmCallId);
    // TODO: tokensIn/tokensOut not available — nginx proxy only captures headers, not response body.
    // Will be addressed when proxy is replaced.
    // expect(typeof detail?.tokensIn).toBe("number");
    // expect(typeof detail?.tokensOut).toBe("number");
  });
});
