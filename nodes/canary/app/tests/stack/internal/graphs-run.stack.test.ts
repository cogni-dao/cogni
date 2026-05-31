// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/internal/graphs-run.stack`
 * Purpose: Verify internal graph execution API with idempotency guarantees.
 * Scope: Tests POST /api/internal/graphs/{graphId}/runs endpoint. Does not test Temporal workflow integration.
 * Invariants:
 *   - EXECUTION_IDEMPOTENCY_PERSISTED: Same Idempotency-Key → same result
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - GRANT_VALIDATED_TWICE: Grant re-validated at execution time
 * Side-effects: IO (database writes, graph execution via mock-openai-api in test mode)
 * Notes: Requires dev stack with DB running (pnpm dev:stack:test).
 * Links: docs/spec/scheduler.md, graphs.run.internal.v1.contract
 * @public
 */

import { randomUUID } from "node:crypto";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/test-constants";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";
import { getContainer } from "@/bootstrap/container";
import { executionGrants, executionRequests, users } from "@/shared/db/schema";

// Token from env (matches METRICS_TOKEN pattern in metrics-endpoint.stack.test.ts)
const SCHEDULER_TOKEN = process.env.SCHEDULER_API_TOKEN ?? "";

/** Test graph ID */
const TEST_GRAPH_ID = "langgraph:poet";

describe("[internal] POST /api/internal/graphs/{graphId}/runs", () => {
  let testActor: TestActor;
  let grantId: string;

  beforeEach(async () => {
    // Ensure test mode
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test (mock-LLM backend)");
    }

    const db = getSeedDb();
    testActor = await seedTestActor(db);

    // Create execution grant for this user
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
    // Cleanup: delete user (cascades to billing_accounts, grants via FK)
    await db.delete(users).where(eq(users.id, testActor.user.id));
    // Don't resetContainer() - reuse connections across tests
  });

  /**
   * Helper to create request with auth and idempotency headers.
   */
  function createRequest(
    graphId: string,
    body: unknown,
    opts: { token?: string; idempotencyKey?: string }
  ): NextRequest {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
      ...(opts.idempotencyKey && { "Idempotency-Key": opts.idempotencyKey }),
    };

    return new NextRequest(
      `http://localhost:3000/api/internal/graphs/${graphId}/runs`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers,
      }
    );
  }

  describe("authentication", () => {
    it("returns 401 when Authorization header missing", async () => {
      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input: { messages: [] } },
        { idempotencyKey: randomUUID() }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 when token is invalid", async () => {
      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input: { messages: [] } },
        { token: "wrong-token", idempotencyKey: randomUUID() }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("idempotency", () => {
    it("returns 400 when Idempotency-Key header missing", async () => {
      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input: { messages: [] } },
        { token: SCHEDULER_TOKEN }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Idempotency-Key");
    });

    it("first request succeeds and stores execution_request", async () => {
      const idempotencyKey = `${randomUUID()}:2025-01-21T09:00:00Z`;
      const input = {
        messages: [{ role: "user", content: "Hello" }],
        modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
      };

      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.runId).toBeDefined();

      // Verify execution_requests record created
      const db = getSeedDb();
      const records = await db
        .select()
        .from(executionRequests)
        .where(eq(executionRequests.idempotencyKey, idempotencyKey));

      expect(records.length).toBe(1);
      expect(records[0]?.runId).toBe(body.runId);
    });

    it("replay with same Idempotency-Key returns cached result", async () => {
      const idempotencyKey = `${randomUUID()}:2025-01-21T09:00:00Z`;
      const input = {
        messages: [{ role: "user", content: "Hello" }],
        modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
      };

      // First request
      const request1 = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );
      const response1 = await POST(request1, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });
      expect(response1.status).toBe(200);
      const body1 = await response1.json();

      // Second request with same key
      const request2 = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );
      const response2 = await POST(request2, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });
      expect(response2.status).toBe(200);
      const body2 = await response2.json();

      // Same runId returned
      expect(body2.runId).toBe(body1.runId);

      // Only one execution_requests row
      const db = getSeedDb();
      const records = await db
        .select()
        .from(executionRequests)
        .where(eq(executionRequests.idempotencyKey, idempotencyKey));
      expect(records.length).toBe(1);
    });

    it("returns 422 when same Idempotency-Key with different payload", async () => {
      const idempotencyKey = `${randomUUID()}:2025-01-21T09:00:00Z`;

      // First request
      const request1 = createRequest(
        TEST_GRAPH_ID,
        {
          executionGrantId: grantId,
          input: {
            messages: [{ role: "user", content: "Hello" }],
            modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
          },
        },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );
      const response1 = await POST(request1, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });
      expect(response1.status).toBe(200);

      // Second request with DIFFERENT input
      const request2 = createRequest(
        TEST_GRAPH_ID,
        {
          executionGrantId: grantId,
          input: {
            messages: [{ role: "user", content: "Different!" }],
            modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
          },
        },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );
      const response2 = await POST(request2, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response2.status).toBe(422);
      const body = await response2.json();
      expect(body.error).toContain("Idempotency conflict");
    });
  });

  describe("redis stream publishing (PUMP_TO_COMPLETION_VIA_REDIS)", () => {
    it("publishes AiEvents to Redis Stream during execution", async () => {
      const idempotencyKey = `${randomUUID()}:2025-01-21T09:00:00Z`;
      const input = {
        messages: [{ role: "user", content: "Hello" }],
        modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
      };

      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);

      // Verify events were published to Redis Stream
      const container = getContainer();
      const ac = new AbortController();
      const events: { type: string }[] = [];

      for await (const entry of container.runStream.subscribe(
        body.runId,
        ac.signal
      )) {
        events.push({ type: entry.event.type });
        // subscribe() terminates on done/error terminal events
      }

      // Must have at least one event and a terminal event
      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[events.length - 1];
      expect(lastEvent?.type === "done" || lastEvent?.type === "error").toBe(
        true
      );
    });
  });

  describe("model validation", () => {
    // Model is required - no fallback allowed
    it("returns 400 when input omits model", async () => {
      const idempotencyKey = `${randomUUID()}:2025-01-21T09:00:00Z`;
      const input = { messages: [{ role: "user", content: "Hello" }] }; // no model

      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input },
        { token: SCHEDULER_TOKEN, idempotencyKey }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("modelRef field is required");
    });
  });

  describe("grant validation", () => {
    it("returns 403 when grant not found", async () => {
      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: randomUUID(), input: { messages: [] } },
        { token: SCHEDULER_TOKEN, idempotencyKey: randomUUID() }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("Grant not found");
    });

    it("returns 403 when grant scope mismatch", async () => {
      // Create grant for different graph
      const db = getSeedDb();
      const wrongScopeGrantId = randomUUID();
      await db.insert(executionGrants).values({
        id: wrongScopeGrantId,
        userId: testActor.user.id,
        billingAccountId: testActor.billingAccountId,
        scopes: ["graph:execute:langgraph:other"],
      });

      const request = createRequest(
        TEST_GRAPH_ID, // Requesting poet but grant is for other
        { executionGrantId: wrongScopeGrantId, input: { messages: [] } },
        { token: SCHEDULER_TOKEN, idempotencyKey: randomUUID() }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("scope");
    });

    it("returns 403 when grant is revoked", async () => {
      // Revoke the grant
      const db = getSeedDb();
      await db
        .update(executionGrants)
        .set({ revokedAt: new Date() })
        .where(eq(executionGrants.id, grantId));

      const request = createRequest(
        TEST_GRAPH_ID,
        { executionGrantId: grantId, input: { messages: [] } },
        { token: SCHEDULER_TOKEN, idempotencyKey: randomUUID() }
      );

      const response = await POST(request, {
        params: Promise.resolve({ graphId: TEST_GRAPH_ID }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("revoked");
    });
  });
});
