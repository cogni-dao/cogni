// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/internal/multi-node-billing.stack`
 * Purpose: E2E multi-node billing isolation tests — prove per-node callback routing,
 *   DB isolation, and auth isolation across operator/poly/resy.
 * Scope: Tests POST billing callbacks via fetch() to each running node's HTTP endpoint.
 *   Verifies receipts land in the correct node's database and nowhere else.
 *   Requires dev:stack:full running (3 nodes + shared LiteLLM + per-node DBs).
 * Invariants:
 *   - NODE_LOCAL_METERING_PRIMARY: each node's billing is authoritative in its own DB
 *   - DB_PER_NODE: receipts only exist in the node they were routed to
 *   - MISSING_NODE_ID_DEFAULTS_OPERATOR: missing node_id → operator
 *   - CHARGE_RECEIPTS_IDEMPOTENT_BY_CALL_ID: duplicate callbacks are no-ops
 *   - CALLBACK_AUTHENTICATED: invalid token rejected with 401
 * Side-effects: IO (HTTP requests to running nodes, database reads for verification)
 * Notes: Runs against dev:stack:full (dev databases, not test databases).
 *   Uses fetch() — not route handler imports — because the full HTTP path through
 *   LiteLLM callback routing is what we're proving.
 * Links: https://node-template.cognidao.org/knowledge/node-tenancy-isolation, https://node-template.cognidao.org/knowledge/billing-ingest-callback, task.0258
 * @public
 */

import { randomUUID } from "node:crypto";
import type { Database } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chargeReceipts } from "@/shared/db/schema";

// ── Node configuration ─────────────────────────────────────────────────────

interface NodeConfig {
  name: string;
  baseUrl: string;
  dbUrl: string;
}

const BILLING_INGEST_TOKEN = process.env.BILLING_INGEST_TOKEN ?? "";

const NODES: Record<string, NodeConfig> = {
  operator: {
    name: "operator",
    baseUrl: process.env.TEST_BASE_URL_OPERATOR ?? "http://localhost:3000",
    dbUrl:
      process.env.DATABASE_SERVICE_URL ??
      "postgresql://app_service:service_password@localhost:55432/cogni_template_stack_test",
  },
  poly: {
    name: "poly",
    baseUrl: process.env.TEST_BASE_URL_POLY ?? "http://localhost:3100",
    dbUrl:
      process.env.DATABASE_SERVICE_URL_POLY ??
      "postgresql://app_service:service_password@localhost:55432/cogni_poly_test",
  },
  resy: {
    name: "resy",
    baseUrl: process.env.TEST_BASE_URL_RESY ?? "http://localhost:3300",
    dbUrl:
      process.env.DATABASE_SERVICE_URL_RESY ??
      "postgresql://app_service:service_password@localhost:55432/cogni_resy_test",
  },
};

// ── DB clients (lazy, per-node) ─────────────────────────────────────────────

const dbClients = new Map<string, Database>();

function getNodeDb(nodeName: string): Database {
  let client = dbClients.get(nodeName);
  if (!client) {
    const node = NODES[nodeName];
    if (!node) throw new Error(`Unknown node: ${nodeName}`);
    client = createServiceDbClient(node.dbUrl);
    dbClients.set(nodeName, client);
  }
  return client;
}

// ── Seed helpers ────────────────────────────────────────────────────────────

// We seed test actors directly into each node's DB using raw SQL via the
// service client (BYPASSRLS). This avoids importing node-specific seed
// fixtures and keeps the test self-contained.

import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";

interface TestActor {
  userId: string;
  billingAccountId: string;
  virtualKeyId: string;
}

async function seedTestActorInDb(db: Database): Promise<TestActor> {
  const userId = randomUUID();
  const billingAccountId = randomUUID();
  const virtualKeyId = randomUUID();
  const walletAddress = `0x${Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("hex").slice(0, 40).padEnd(40, "0")}`;

  await db
    .insert(users)
    .values({ id: userId, name: "Multi-Node Test User", walletAddress })
    .onConflictDoNothing({ target: users.id });

  await db
    .insert(billingAccounts)
    .values({
      id: billingAccountId,
      ownerUserId: userId,
      balanceCredits: 100_000_000n,
    })
    .onConflictDoNothing({ target: billingAccounts.id });

  await db
    .insert(virtualKeys)
    .values({
      id: virtualKeyId,
      billingAccountId,
      isDefault: true,
      label: "Test Default Key",
    })
    .onConflictDoNothing({ target: virtualKeys.id });

  return { userId, billingAccountId, virtualKeyId };
}

async function cleanupTestActor(db: Database, actor: TestActor): Promise<void> {
  // Delete in reverse FK order
  await db
    .delete(chargeReceipts)
    .where(eq(chargeReceipts.billingAccountId, actor.billingAccountId));
  await db
    .delete(virtualKeys)
    .where(eq(virtualKeys.billingAccountId, actor.billingAccountId));
  await db
    .delete(billingAccounts)
    .where(eq(billingAccounts.id, actor.billingAccountId));
  await db.delete(users).where(eq(users.id, actor.userId));
}

// ── Billing ingest helpers ──────────────────────────────────────────────────

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
      model: "openai/mock-gpt-markdown",
      model_group: "test-model",
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

async function postBillingIngest(
  nodeBaseUrl: string,
  payload: unknown[],
  token: string = BILLING_INGEST_TOKEN
): Promise<Response> {
  return fetch(`${nodeBaseUrl}/api/internal/billing/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

async function queryReceipts(db: Database, billingAccountId: string) {
  return db
    .select()
    .from(chargeReceipts)
    .where(eq(chargeReceipts.billingAccountId, billingAccountId));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("[multi-node] billing isolation (task.0258)", () => {
  // Per-node test actors — seeded in each node's DB
  const actors: Record<string, TestActor> = {};

  function requireActor(name: string): TestActor {
    const actor = actors[name];
    if (!actor) throw new Error(`Test actor "${name}" not seeded`);
    return actor;
  }

  beforeAll(async () => {
    // Node liveness already verified by globalSetup (wait-for-probes-multi.ts)
    // Seed test actors in each node's DB
    for (const name of Object.keys(NODES)) {
      const db = getNodeDb(name);
      actors[name] = await seedTestActorInDb(db);
    }
  }, 30_000);

  afterAll(async () => {
    // Cleanup test actors from each node's DB
    for (const [name, actor] of Object.entries(actors)) {
      try {
        await cleanupTestActor(getNodeDb(name), actor);
      } catch {
        // Best effort cleanup
      }
    }
  });

  // ── Test 1: Operator baseline ───────────────────────────────────────────

  it("operator callback → receipt in operator DB", async () => {
    const actor = requireActor("operator");
    const { entry, litellmCallId } = makeCallbackPayload(
      actor.billingAccountId
    );

    const res = await postBillingIngest(NODES.operator?.baseUrl, [entry]);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.processed).toBe(1);

    const receipts = await queryReceipts(
      getNodeDb("operator"),
      actor.billingAccountId
    );
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.sourceReference).toContain(litellmCallId);
  });

  // ── Test 2: Poly isolation ──────────────────────────────────────────────

  it("poly callback → receipt in poly DB (NODE_LOCAL_METERING_PRIMARY)", async () => {
    const actor = requireActor("poly");
    const { entry, litellmCallId } = makeCallbackPayload(
      actor.billingAccountId
    );

    const res = await postBillingIngest(NODES.poly?.baseUrl, [entry]);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.processed).toBe(1);

    const receipts = await queryReceipts(
      getNodeDb("poly"),
      actor.billingAccountId
    );
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.sourceReference).toContain(litellmCallId);
  });

  // ── Test 3: Resy isolation ──────────────────────────────────────────────

  it("resy callback → receipt in resy DB (NODE_LOCAL_METERING_PRIMARY)", async () => {
    const actor = requireActor("resy");
    const { entry, litellmCallId } = makeCallbackPayload(
      actor.billingAccountId
    );

    const res = await postBillingIngest(NODES.resy?.baseUrl, [entry]);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.processed).toBe(1);

    const receipts = await queryReceipts(
      getNodeDb("resy"),
      actor.billingAccountId
    );
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.sourceReference).toContain(litellmCallId);
  });

  // ── Test 4: Cross-node isolation ────────────────────────────────────────

  it("poly receipt absent from operator + resy DBs (DB_PER_NODE)", async () => {
    const polyActor = requireActor("poly");

    // Query operator and resy DBs for the poly actor's billing account
    const operatorReceipts = await queryReceipts(
      getNodeDb("operator"),
      polyActor.billingAccountId
    );
    const resyReceipts = await queryReceipts(
      getNodeDb("resy"),
      polyActor.billingAccountId
    );

    expect(operatorReceipts.length).toBe(0);
    expect(resyReceipts.length).toBe(0);
  });

  // ── Test 5: Idempotency ─────────────────────────────────────────────────

  it("duplicate callback is idempotent per node (CHARGE_RECEIPTS_IDEMPOTENT_BY_CALL_ID)", async () => {
    const actor = requireActor("operator");
    const { entry } = makeCallbackPayload(actor.billingAccountId);

    // Send same payload twice
    const res1 = await postBillingIngest(NODES.operator?.baseUrl, [entry]);
    expect(res1.status).toBe(200);

    const res2 = await postBillingIngest(NODES.operator?.baseUrl, [entry]);
    expect(res2.status).toBe(200);

    // Should still be exactly the receipts from test 1 + this one (no duplicates from double-send)
    const receipts = await queryReceipts(
      getNodeDb("operator"),
      actor.billingAccountId
    );
    // We have 1 from test 1, and this test added 1 more (the dup was a no-op)
    // Find receipts with this specific call ID
    const thisCallReceipts = receipts.filter((r) =>
      r.sourceReference?.includes(entry.id)
    );
    expect(thisCallReceipts.length).toBe(1);
  });

  // ── Test 6: Auth rejection ──────────────────────────────────────────────

  it("invalid token rejected (CALLBACK_AUTHENTICATED)", async () => {
    const { entry } = makeCallbackPayload(randomUUID());

    const res = await postBillingIngest(
      NODES.operator?.baseUrl,
      [entry],
      "wrong-token-that-should-be-rejected"
    );
    expect(res.status).toBe(401);
  });
});
