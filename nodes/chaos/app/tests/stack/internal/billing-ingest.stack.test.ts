// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/internal/billing-ingest.stack`
 * Purpose: Verify billing ingest endpoint writes charge_receipts from LiteLLM callback payloads.
 * Scope: Integration test calling POST /api/internal/billing/ingest and asserting DB rows. Does not test LiteLLM itself.
 * Invariants:
 *   - CALLBACK_AUTHENTICATED: Bearer token required
 *   - IDEMPOTENCY_KEY_IS_LITELLM_CALL_ID: Duplicate callbacks are no-ops
 *   - COST_AUTHORITY_IS_LITELLM: response_cost from callback writes to charge_receipts
 * Side-effects: IO (database writes via commitUsageFact)
 * Notes: Requires dev:stack:test running (DB + app).
 * Links: src/app/api/internal/billing/ingest/route.ts, docs/spec/billing-ingest.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/internal/billing/ingest/route";
import { chargeReceipts, llmChargeDetails, users } from "@/shared/db/schema";

const BILLING_INGEST_TOKEN = process.env.BILLING_INGEST_TOKEN ?? "";

function makeCallbackPayload(
  billingAccountId: string,
  overrides: Record<string, unknown> = {}
) {
  const litellmCallId = randomUUID();
  const runId = randomUUID();
  return {
    entry: {
      id: litellmCallId,
      call_type: "acompletion",
      stream: true,
      status: "success",
      response_cost: 0.0015,
      model: "google/gemini-2.5-flash",
      model_group: "gemini-2.5-flash",
      custom_llm_provider: "openrouter",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      end_user: billingAccountId,
      metadata: {
        spend_logs_metadata: {
          run_id: runId,
          graph_id: "langgraph:poet",
          attempt: 0,
        },
        requester_custom_headers: {},
      },
      ...overrides,
    },
    litellmCallId,
    runId,
  };
}

function createRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/internal/billing/ingest", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BILLING_INGEST_TOKEN}`,
    },
  });
}

describe("[internal] POST /api/internal/billing/ingest", () => {
  let testActor: TestActor;

  beforeEach(async () => {
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test");
    }
    const db = getSeedDb();
    testActor = await seedTestActor(db);
  });

  afterEach(async () => {
    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, testActor.user.id));
  });

  it("callback creates charge_receipt with correct cost", async () => {
    const { entry, runId } = makeCallbackPayload(testActor.billingAccountId);

    const response = await POST(createRequest([entry]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ processed: 1, skipped: 0 });

    // Verify charge_receipt row
    const db = getSeedDb();
    const receipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt).toBeDefined();
    expect(receipt?.billingAccountId).toBe(testActor.billingAccountId);
    expect(receipt?.virtualKeyId).toBe(testActor.virtualKeyId);
    expect(receipt?.responseCostUsd).not.toBeNull();
    expect(Number(receipt?.responseCostUsd)).toBeGreaterThan(0);
    expect(receipt?.chargedCredits).toBeGreaterThan(0n);

    // Verify linked llm_charge_details
    const details = receipt
      ? await db
          .select()
          .from(llmChargeDetails)
          .where(eq(llmChargeDetails.chargeReceiptId, receipt.id))
      : [];

    expect(details).toHaveLength(1);
    const [detail] = details;
    expect(detail?.model).toBe("gemini-2.5-flash");
    expect(detail?.graphId).toBe("langgraph:poet");
  });

  it("duplicate callback is idempotent (no duplicate receipt)", async () => {
    const { entry, runId } = makeCallbackPayload(testActor.billingAccountId);

    // First call
    const res1 = await POST(createRequest([entry]));
    expect(res1.status).toBe(200);

    // Second call with same payload (duplicate callback)
    const res2 = await POST(createRequest([entry]));
    expect(res2.status).toBe(200);

    // Should still have exactly 1 receipt (idempotent)
    const db = getSeedDb();
    const receipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    expect(receipts).toHaveLength(1);
  });

  it.skip("OpenRouter paid model with response_cost>0 writes non-zero receipt", async () => {
    const { entry, runId } = makeCallbackPayload(testActor.billingAccountId, {
      response_cost: 0.00653,
      model: "openrouter/anthropic/claude-opus-4-6",
      model_group: "test-paid-model",
      custom_llm_provider: "openrouter",
      prompt_tokens: 880,
      completion_tokens: 120,
      total_tokens: 1000,
    });

    const response = await POST(createRequest([entry]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ processed: 1, skipped: 0 });

    const db = getSeedDb();
    const receipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt?.responseCostUsd).not.toBeNull();
    expect(Number(receipt?.responseCostUsd)).toBeGreaterThan(0);
    expect(receipt?.chargedCredits).toBeGreaterThan(0n);
  });

  it.skip("known-paid OpenRouter model with response_cost=0 is deferred (no receipt written)", async () => {
    const { entry, runId } = makeCallbackPayload(testActor.billingAccountId, {
      response_cost: 0,
      model: "openrouter/anthropic/claude-opus-4-6",
      model_group: "test-paid-model",
      custom_llm_provider: "openrouter",
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
    });

    const response = await POST(createRequest([entry]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ processed: 1, skipped: 0 });

    const db = getSeedDb();
    const receipts = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.runId, runId));

    // Guardrail for bug.0060: do not persist a final $0 receipt for paid models (per model_info.is_free).
    expect(receipts).toHaveLength(0);
  });

  it("returns 401 for invalid token", async () => {
    const { entry } = makeCallbackPayload(testActor.billingAccountId);

    const request = new NextRequest(
      "http://localhost:3000/api/internal/billing/ingest",
      {
        method: "POST",
        body: JSON.stringify([entry]),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token-that-is-long-enough-32ch",
        },
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});
