// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/schedules.credit-gate`
 * Purpose: Verifies schedule creation no longer gates on credits (moved to execution time).
 * Scope: Route-level test with mocked container. Does not test database or Temporal.
 * Invariants:
 *   - Schedule creation always succeeds regardless of balance
 *   - Credit gating happens at execution time via PreflightCreditCheckDecorator
 * Side-effects: none
 * Links: src/app/api/v1/schedules/route.ts, docs/spec/multi-provider-llm.md
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock session authentication
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

const mockAccountService = {
  getOrCreateBillingAccountForUser: vi.fn(),
  getBalance: vi.fn(),
  getBillingAccount: vi.fn(),
  recordChargeReceipt: vi.fn(),
  listChargeReceipts: vi.fn(),
  getBalanceHistory: vi.fn(),
};

const mockScheduleManager = {
  createSchedule: vi.fn(),
  listSchedules: vi.fn(),
  getSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
};

// Mock bootstrap container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    config: {
      unhandledErrorPolicy: "rethrow",
    },
    accountsForUser: vi.fn(() => mockAccountService),
    scheduleManager: mockScheduleManager,
  })),
}));

vi.mock("@/shared/config", () => ({
  getNodeId: () => "node_template",
}));

// Import after mocks
import { getSessionUser } from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/schedules/route";

const VALID_SCHEDULE_BODY = {
  graphId: "langgraph:poet",
  input: { messages: [{ role: "user", content: "Hello" }], model: "gpt-4o" },
  cron: "0 9 * * *",
  timezone: "UTC",
};

const CREATED_SCHEDULE = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  graphId: "langgraph:poet",
  input: VALID_SCHEDULE_BODY.input,
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: new Date("2026-01-18T09:00:00.000Z"),
  lastRunAt: null,
  createdAt: new Date("2026-01-18T00:00:00.000Z"),
  updatedAt: new Date("2026-01-18T00:00:00.000Z"),
};

describe("POST /api/v1/schedules - Credit Gate Removed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    mockAccountService.getOrCreateBillingAccountForUser.mockResolvedValue({
      id: "ba-test",
      ownerUserId: TEST_SESSION_USER_1.id,
      defaultVirtualKeyId: "vk-test",
    });
    mockScheduleManager.createSchedule.mockResolvedValue(CREATED_SCHEDULE);
  });

  it("allows paid model with zero balance → 201 (credit gating at execution time)", async () => {
    mockAccountService.getBalance.mockResolvedValue(0);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify(VALID_SCHEDULE_BODY),
        });

        // Schedule creation succeeds — credit gating happens at execution time
        expect(response.status).toBe(201);
        expect(mockScheduleManager.createSchedule).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("allows no-model input with zero balance → 201", async () => {
    mockAccountService.getBalance.mockResolvedValue(0);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            ...VALID_SCHEDULE_BODY,
            input: { messages: [] }, // no model field
          }),
        });

        expect(response.status).toBe(201);
        expect(mockScheduleManager.createSchedule).toHaveBeenCalledTimes(1);
      },
    });
  });
});
