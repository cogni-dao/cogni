// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/billing-ingest-system-free.contract`
 * Purpose: A system-paid (free) review call lands a $0 receipt on the cogni_system account through the REAL
 *   billing ingest route and the REAL commitUsageFact (story.0038).
 * Scope: Route + real usage-commit logic with a recording account service; no database. The ledger insert itself is
 *   the account adapter's (covered by its own tests and the stack tier, which needs docker).
 * Invariants:
 *   - OWNER_SCOPED_RECEIPT: the receipt is written through the account service scoped to the system account's OWNER.
 *   - ZERO_COST_RECEIPT: a $0 provider cost still writes a receipt (RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST), with 0 credits.
 * Side-effects: none
 * Links: src/app/api/internal/billing/ingest/route.ts, src/features/ai/services/billing.ts
 * @internal
 */

import { SYSTEM_BILLING_ACCOUNT } from "@tests/_fakes/ids";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "x".repeat(32);
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    ...MOCK_SERVER_ENV,
    BILLING_INGEST_TOKEN: TOKEN,
    USER_PRICE_MARKUP_FACTOR: 2,
  }),
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: vi.fn(
    async (
      _n: string,
      _a: Record<string, string>,
      handler: (c: {
        traceId: string;
        span: { setAttribute: () => void };
      }) => Promise<unknown>
    ) => handler({ traceId: "t", span: { setAttribute: vi.fn() } })
  ),
}));
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelFreeFromCache: vi.fn().mockReturnValue(true),
  getDisplayNameFromCache: vi.fn().mockReturnValue(null),
}));

const recordChargeReceipt = vi.hoisted(() => vi.fn());
const accountsForUser = vi.hoisted(() => vi.fn());
const getBillingAccountById = vi.hoisted(() => vi.fn());
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    clock: { now: () => new Date("2026-11-11T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    serviceAccountService: { getBillingAccountById },
    accountsForUser,
  }),
}));
// The REAL usage commit, not a stub.
vi.mock("@/features/ai/public.server", async () => ({
  commitUsageFact: (await import("@/features/ai/services/billing"))
    .commitUsageFact,
}));

import * as appHandler from "@/app/api/internal/billing/ingest/route";

type FetchFn = (init?: RequestInit) => Promise<Response>;

describe("billing ingest: system_free review call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBillingAccountById.mockResolvedValue(SYSTEM_BILLING_ACCOUNT);
    accountsForUser.mockReturnValue({ recordChargeReceipt });
    recordChargeReceipt.mockResolvedValue(undefined);
  });

  it("writes a $0 receipt on cogni_system through the system owner's account service", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }: { fetch: FetchFn }) => {
        const res = await fetch({
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify([
            {
              id: "litellm-call-free-1",
              call_type: "acompletion",
              stream: true,
              status: "success",
              response_cost: 0,
              model: "deepseek-v4-flash",
              model_group: "deepseek-v4-flash",
              custom_llm_provider: "openrouter",
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              end_user: SYSTEM_BILLING_ACCOUNT.id,
              metadata: {
                spend_logs_metadata: {
                  run_id: "run-free-1",
                  graph_id: "langgraph:pr-review",
                  attempt: 0,
                },
                requester_custom_headers: {},
              },
            },
          ]),
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ processed: 1, skipped: 0 });
      },
    });
    expect(getBillingAccountById).toHaveBeenCalledWith(
      SYSTEM_BILLING_ACCOUNT.id
    );
    expect(accountsForUser).toHaveBeenCalledWith(
      SYSTEM_BILLING_ACCOUNT.ownerUserId
    );
    expect(recordChargeReceipt).toHaveBeenCalledTimes(1);
    expect(recordChargeReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        billingAccountId: SYSTEM_BILLING_ACCOUNT.id,
        virtualKeyId: SYSTEM_BILLING_ACCOUNT.defaultVirtualKeyId,
        runId: "run-free-1",
        chargedCredits: 0n,
        responseCostUsd: 0,
      })
    );
  });
});
