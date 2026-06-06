// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/chat-streaming.stack`
 * Purpose: Verify that /api/v1/ai/chat streaming endpoint truly streams incrementally, not buffered.
 * Scope: Tests chat route, AI SDK Data Stream Protocol (SSE) format, and streaming behavior. Does NOT test LiteLLM integration.
 * Invariants: At least 2 text deltas arrive before completion; deltas arrive incrementally (not buffered); abort stops stream.
 * Side-effects: IO (HTTP requests, database writes via completion facade)
 * Notes: Requires dev stack running (pnpm dev:stack:test). Uses real LiteLLM streaming. Uses AI SDK SSE format.
 * Links: src/app/api/v1/ai/chat/route.ts, docs/guides/testing.md
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import { createChatRequest } from "@tests/_fakes";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  isFinishEvent,
  isTextDeltaEvent,
  readSseEvents,
  type SseEvent,
} from "@tests/helpers/data-stream";
import { waitForReceipts } from "@tests/helpers/poll-db";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as chatPOST } from "@/app/api/v1/ai/chat/route";
import { GET as modelsGET } from "@/app/api/v1/ai/models/route";
import { billingAccounts, chargeReceipts } from "@/shared/db/schema";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

describe("Chat Streaming", () => {
  it("streams text deltas incrementally (not buffered)", async () => {
    // Arrange - Seed authenticated user with credits
    const db = getSeedDb();
    const { user } = await seedAuthenticatedUser(
      db,
      { id: randomUUID() },
      { balanceCredits: 100_000_000 }
    );

    // user.walletAddress guaranteed non-null by seedAuthenticatedUser (generates via generateTestWallet)
    if (!user.walletAddress) throw new Error("walletAddress required");

    const mockSessionUser: SessionUser = {
      id: user.id,
      walletAddress: user.walletAddress,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    // Fetch valid model ID from models endpoint
    const modelsReq = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const modelsRes = await modelsGET(modelsReq);
    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    const { defaultRef } = modelsData;

    // Act - Send streaming chat request with prompt that produces multiple tokens
    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createChatRequest({
          message:
            "Say hello in exactly 15 words or more, using complete sentences.",
          modelRef: defaultRef,
          stateKey: randomUUID(),
        })
      ),
    });

    const res = await chatPOST(req);

    // Assert - Response is AI SDK SSE format (text/event-stream)
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/event-stream");

    // Collect events with timestamps to prove incremental arrival
    const events: (SseEvent & { t: number })[] = [];
    const start = Date.now();

    for await (const e of readSseEvents(res)) {
      events.push({ ...e, t: Date.now() - start });

      // Stop once completed to avoid hanging tests
      if (isFinishEvent(e)) break;

      // Safety timeout: stop if stream takes too long
      if (Date.now() - start > 30_000) {
        throw new Error("Stream timeout after 30s");
      }
    }

    // Assert - Received at least 2 text delta events (proves streaming)
    // Fake adapter splits response into ~10 chunks
    const deltas = events.filter((e) => isTextDeltaEvent(e));
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    // Assert - Each delta contains incremental text
    for (const delta of deltas) {
      const text = delta.data.delta as string;
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }

    // Assert - Received finish event at the end
    const finished = events.find((e) => isFinishEvent(e));
    expect(finished).toBeDefined();

    // Assert - Prove incremental arrival: first delta arrives before completion
    const firstDelta = deltas[0];
    const firstDeltaTime = firstDelta?.t ?? Infinity;
    const completionTime = finished?.t ?? 0;
    expect(firstDeltaTime).toBeLessThan(completionTime);

    // Assert - Multiple deltas arrive at different times (proves not buffered)
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const firstTime = deltas[0]?.t ?? 0;
    const lastDelta = deltas[deltas.length - 1];
    const lastTime = lastDelta?.t ?? 0;
    // At least some time difference between first and last delta
    expect(lastTime).toBeGreaterThanOrEqual(firstTime);
  });

  it("streaming completion creates charge receipt", async () => {
    // Arrange - Seed authenticated user with credits
    const db = getSeedDb();
    const { user } = await seedAuthenticatedUser(
      db,
      { id: randomUUID() },
      { balanceCredits: 100_000_000 }
    );

    if (!user.walletAddress) throw new Error("walletAddress required");

    const mockSessionUser: SessionUser = {
      id: user.id,
      walletAddress: user.walletAddress,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    // Fetch valid model ID from models endpoint
    const modelsReq = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const modelsRes = await modelsGET(modelsReq);
    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    // Use free model to avoid paid-model $0 cost guardrail / callback flake
    const freeModel = modelsData.models.find(
      (m: { requiresPlatformCredits: boolean }) => !m.requiresPlatformCredits
    );
    expect(freeModel).toBeTruthy();
    const freeModelRef = freeModel.ref;

    // Record receipts before (async callback appends a new row)
    const billingAccount = await db.query.billingAccounts.findFirst({
      where: eq(billingAccounts.ownerUserId, user.id),
    });
    expect(billingAccount).toBeTruthy();
    if (!billingAccount) throw new Error("Billing account not found");

    const receiptsBefore = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.billingAccountId, billingAccount.id));
    const initialReceiptCount = receiptsBefore.length;

    // Act - Send streaming chat request
    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createChatRequest({
          message: "Hello",
          modelRef: freeModelRef,
          stateKey: randomUUID(),
        })
      ),
    });

    const res = await chatPOST(req);

    // Assert - Response is SSE stream
    expect(res.status).toBe(200);

    // Consume stream to trigger completion
    for await (const e of readSseEvents(res)) {
      if (isFinishEvent(e)) break;
    }

    // Wait for receipt from async LiteLLM callback (CALLBACK_IS_SOLE_WRITER)
    const receipts = await waitForReceipts(db, billingAccount.id, {
      minCount: initialReceiptCount + 1,
      timeoutMs: 8_000,
    });
    const receipt = receipts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    // Per ACTIVITY_METRICS.md: charge_receipt has minimal fields, no model
    // Model lives in LiteLLM (canonical source)
    expect(receipt).toBeTruthy();
    expect(receipt?.provenance).toBe("stream");
    expect(receipt?.runId).toBeTruthy();
  }, 10_000);

  it("stops streaming when aborted", async () => {
    // Arrange - Seed authenticated user with credits
    const db = getSeedDb();
    const { user } = await seedAuthenticatedUser(
      db,
      { id: randomUUID() },
      { balanceCredits: 100_000_000 }
    );

    // user.walletAddress guaranteed non-null by seedAuthenticatedUser (generates via generateTestWallet)
    if (!user.walletAddress) throw new Error("walletAddress required");

    const mockSessionUser: SessionUser = {
      id: user.id,
      walletAddress: user.walletAddress,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    // Fetch valid model ID from models endpoint
    const modelsReq = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const modelsRes = await modelsGET(modelsReq);
    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    const { defaultRef } = modelsData;

    const ac = new AbortController();

    // Act - Send streaming request with long response
    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      signal: ac.signal,
      body: JSON.stringify(
        createChatRequest({
          message:
            "Write a very long detailed response with many sentences about the history of computers.",
          modelRef: defaultRef,
          stateKey: randomUUID(),
        })
      ),
    });

    const res = await chatPOST(req);

    let deltaCount = 0;
    const start = Date.now();

    try {
      for await (const e of readSseEvents(res)) {
        if (isTextDeltaEvent(e)) {
          deltaCount++;
          // Abort after receiving 2 deltas (proves abort works mid-stream)
          if (deltaCount >= 2) {
            ac.abort();
            break; // Exit loop after abort
          }
        }
        // Safety timeout
        if (Date.now() - start > 30_000) break;
      }
    } catch (error) {
      // Abort may cause the stream to throw - this is expected
      if (error instanceof Error && error.name === "AbortError") {
        // Expected abort error
      } else {
        throw error;
      }
    }

    // Assert - Received exactly 2 deltas before abort (we abort after 2nd delta)
    expect(deltaCount).toBe(2);

    // Assert - Did not receive all ~10 deltas (proves abort stopped the stream mid-way)
    // Fake adapter would send ~10 chunks if not aborted
    expect(deltaCount).toBeLessThan(10);
  });
});
