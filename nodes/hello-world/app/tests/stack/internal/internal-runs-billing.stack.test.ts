// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/internal/internal-runs-billing.stack`
 * Purpose: Verify that internal/scheduled graph runs produce charge_receipts.
 * Scope: Integration test hitting POST /api/internal/graphs/{graphId}/runs and asserting billing DB rows. Does not test UI chat path or idempotency (see graphs-run.stack.test.ts).
 * Invariants:
 *   - CALLBACK_IS_SOLE_WRITER: Receipts arrive via async LiteLLM callback, not in-process decorator
 * Side-effects: IO (database writes, graph execution via mock-openai-api in test mode)
 * Notes: Regression test for bug.0005 (scheduled runs bypass billing). Requires dev stack with DB + LiteLLM running.
 * Links: task.0007, bug.0005, graphs-run.stack.test.ts, completion-billing.stack.test.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/test-constants";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { waitForReceipts } from "@tests/helpers/poll-db";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";
import { executionGrants, llmChargeDetails, users } from "@/shared/db/schema";

const SCHEDULER_TOKEN = process.env.SCHEDULER_API_TOKEN ?? "";
const TEST_GRAPH_ID = "langgraph:poet";

describe("[internal] billing via UsageCommitDecorator (bug.0005 regression)", () => {
  let testActor: TestActor;
  let grantId: string;

  beforeEach(async () => {
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test (mock-LLM backend)");
    }

    const db = getSeedDb();
    testActor = await seedTestActor(db);

    grantId = randomUUID();
    await db.insert(executionGrants).values({
      id: grantId,
      userId: testActor.user.id,
      billingAccountId: testActor.billingAccountId,
      scopes: [`graph:execute:${TEST_GRAPH_ID}`],
    });
  });

  afterEach(async () => {
    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, testActor.user.id));
  });

  it("successful internal run creates charge_receipt row", async () => {
    const idempotencyKey = `${randomUUID()}:billing-test`;
    const request = new NextRequest(
      `http://localhost:3000/api/internal/graphs/${TEST_GRAPH_ID}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          executionGrantId: grantId,
          input: {
            messages: [{ role: "user", content: "Say hello in one word." }],
            modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
          },
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SCHEDULER_TOKEN}`,
          "Idempotency-Key": idempotencyKey,
        },
      }
    );

    // Act
    const response = await POST(request, {
      params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
    });

    // Assert — execution succeeded
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.runId).toBeDefined();

    // Assert — charge_receipt row exists (arrives via async LiteLLM callback)
    const db = getSeedDb();
    const receiptRows = await waitForReceipts(db, testActor.billingAccountId);

    expect(receiptRows.length).toBeGreaterThanOrEqual(1);
    const receipt = receiptRows[0] as (typeof receiptRows)[number];

    // Verify receipt is tied to this run
    expect(receipt.runId).toBe(body.runId);
    expect(receipt.virtualKeyId).toBe(testActor.virtualKeyId);

    // Assert — linked llm_charge_details row exists
    const details = await db
      .select()
      .from(llmChargeDetails)
      .where(eq(llmChargeDetails.chargeReceiptId, receipt.id));

    expect(details.length).toBeGreaterThanOrEqual(1);
    const detail = details[0] as (typeof details)[number];
    expect(detail.graphId).toBeTruthy();
  });
});
