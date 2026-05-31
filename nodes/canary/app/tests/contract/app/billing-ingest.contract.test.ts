// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/billing-ingest.contract`
 * Purpose: Verifies billing ingest endpoint auth, Zod validation, billing account resolution, and commitUsageFact delegation.
 * Scope: Route-level test with mocked container and commitUsageFact. Does not test database or actual billing logic.
 * Invariants:
 *   - CALLBACK_AUTHENTICATED: Missing/wrong bearer token → 401
 *   - Valid payload → resolves billing account → calls commitUsageFact per entry
 *   - Non-success entries and unresolvable billing accounts are skipped
 *   - Response shape: { processed, skipped }
 * Side-effects: none
 * Links: src/app/api/internal/billing/ingest/route.ts, docs/spec/billing-ingest.md
 * @internal
 */

import { SYSTEM_BILLING_ACCOUNT, TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must be before imports) ---

// Mock serverEnv to provide BILLING_INGEST_TOKEN
const TEST_BILLING_TOKEN = "x".repeat(32);
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    ...MOCK_SERVER_ENV,
    BILLING_INGEST_TOKEN: TEST_BILLING_TOKEN,
  }),
}));

// Mock OTel root span — passthrough
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: vi.fn(
    async (
      _name: string,
      _attrs: Record<string, string>,
      handler: (ctx: {
        traceId: string;
        span: { setAttribute: () => void };
      }) => Promise<unknown>
    ) => {
      const noopSpan = { setAttribute: vi.fn() };
      return handler({ traceId: "test-trace-id", span: noopSpan });
    }
  ),
}));

// Mock model catalog (route uses isModelFreeFromCache for guardrail, getDisplayNameFromCache for display names)
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelFreeFromCache: vi.fn().mockReturnValue(null),
  getDisplayNameFromCache: vi.fn().mockReturnValue(null),
}));

const mockAccountService = {
  getOrCreateBillingAccountForUser: vi.fn(),
  getBalance: vi.fn(),
  getBillingAccountById: vi.fn(),
  recordChargeReceipt: vi.fn(),
  listChargeReceipts: vi.fn(),
  getBalanceHistory: vi.fn(),
  debitForUsage: vi.fn(),
  creditAccount: vi.fn(),
  listLlmChargeDetails: vi.fn(),
  listCreditLedgerEntries: vi.fn(),
  findCreditLedgerEntryByReference: vi.fn(),
};

const mockServiceAccountService = {
  getBillingAccountById: vi.fn(),
  getOrCreateBillingAccountForUser: vi.fn(),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    clock: { now: () => new Date("2026-02-13T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    serviceAccountService: mockServiceAccountService,
    accountsForUser: vi.fn(() => mockAccountService),
  })),
}));

// Mock commitUsageFact — we test that the route calls it correctly, not billing internals
vi.mock("@/features/ai/public.server", () => ({
  commitUsageFact: vi.fn(),
}));

// --- Imports (after mocks) ---
import * as appHandler from "@/app/api/internal/billing/ingest/route";
import { commitUsageFact } from "@/features/ai/public.server";

// --- Fixtures ---

/** Minimal valid StandardLoggingPayload entry */
function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "litellm-call-123",
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
    end_user: "ba-test-123",
    metadata: {
      spend_logs_metadata: {
        run_id: "run-abc",
        graph_id: "langgraph:poet",
        attempt: 0,
      },
      requester_custom_headers: {},
    },
    ...overrides,
  };
}

const BILLING_ACCOUNT = {
  id: "ba-test-123",
  ownerUserId: TEST_USER_ID_1,
  defaultVirtualKeyId: "vk-default-1",
};

type FetchFn = (init?: RequestInit) => Promise<Response>;

describe("POST /api/internal/billing/ingest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockServiceAccountService.getBillingAccountById.mockResolvedValue(
      BILLING_ACCOUNT
    );
  });

  // ---- Auth tests ----

  it("returns 401 when Authorization header is missing", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify([makeEntry()]),
        });
        expect(res.status).toBe(401);
        expect(commitUsageFact).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 401 when token is wrong", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: "Bearer wrong-token" },
          body: JSON.stringify([makeEntry()]),
        });
        expect(res.status).toBe(401);
      },
    });
  });

  // ---- Validation tests ----

  it("returns 400 for non-array body", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify({ not: "an array" }),
        });
        expect(res.status).toBe(400);
      },
    });
  });

  it("returns 400 for entries missing required fields", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([{ id: "only-id" }]),
        });
        expect(res.status).toBe(400);
      },
    });
  });

  // ---- Happy path ----

  it("processes a single valid entry → { processed: 1, skipped: 0 }", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([makeEntry()]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 1, skipped: 0 });
        expect(commitUsageFact).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("processes batched entries (2 entries)", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([
            makeEntry({ id: "call-1" }),
            makeEntry({ id: "call-2" }),
          ]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 2, skipped: 0 });
        expect(commitUsageFact).toHaveBeenCalledTimes(2);
      },
    });
  });

  // ---- Skip conditions ----

  it("skips non-success entries", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([makeEntry({ status: "failure" })]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 0, skipped: 1 });
        expect(commitUsageFact).not.toHaveBeenCalled();
      },
    });
  });

  it("falls back to system account when end_user is empty and no header fallback", async () => {
    mockServiceAccountService.getBillingAccountById.mockResolvedValue(
      SYSTEM_BILLING_ACCOUNT
    );

    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([
            makeEntry({
              end_user: "",
              metadata: {
                spend_logs_metadata: { run_id: "run-1" },
                requester_custom_headers: {},
              },
            }),
          ]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 1, skipped: 0 });
        expect(
          mockServiceAccountService.getBillingAccountById
        ).toHaveBeenCalledWith(SYSTEM_BILLING_ACCOUNT.id);
        expect(commitUsageFact).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("resolves billingAccountId from header fallback when end_user is empty", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([
            makeEntry({
              end_user: "",
              metadata: {
                spend_logs_metadata: { run_id: "run-1" },
                requester_custom_headers: {
                  "x-litellm-end-user-id": "ba-test-123",
                },
              },
            }),
          ]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 1, skipped: 0 });
        expect(
          mockServiceAccountService.getBillingAccountById
        ).toHaveBeenCalledWith("ba-test-123");
      },
    });
  });

  it("skips entry when billing account not found", async () => {
    mockServiceAccountService.getBillingAccountById.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([makeEntry()]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 0, skipped: 1 });
        expect(commitUsageFact).not.toHaveBeenCalled();
      },
    });
  });

  // ---- Mixed batch ----

  it("handles mixed batch: 1 success + 1 failure + 1 missing account", async () => {
    mockServiceAccountService.getBillingAccountById
      .mockResolvedValueOnce(BILLING_ACCOUNT) // entry 1: found
      .mockResolvedValueOnce(null); // entry 3: not found

    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_BILLING_TOKEN}` },
          body: JSON.stringify([
            makeEntry({ id: "call-1" }), // success
            makeEntry({ id: "call-2", status: "failure" }), // skipped
            makeEntry({ id: "call-3", end_user: "ba-unknown" }), // account not found
          ]),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({ processed: 1, skipped: 2 });
        expect(commitUsageFact).toHaveBeenCalledTimes(1);
      },
    });
  });
});
