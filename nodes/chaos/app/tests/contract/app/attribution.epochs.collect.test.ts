// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.collect`
 * Purpose: Contract tests for POST /api/v1/attribution/epochs/collect endpoint.
 * Scope: Verifies session auth, cooldown enforcement, schedule-not-found, and success response shape. Does not test Temporal or workflow logic.
 * Invariants:
 *   - SESSION_AUTH: Unauthenticated requests -> 401
 *   - COOLDOWN_ENFORCED: Requests within 5 minutes of last run -> 429
 *   - SCHEDULE_NOT_FOUND: Missing schedule -> 404
 *   - RESPONSE_CONTRACT_STABLE: Success returns contract-valid response
 * Side-effects: none
 * Links: src/app/api/v1/attribution/epochs/collect/route.ts
 * @internal
 */

import {
  CollectTriggerCooldownResponseSchema,
  CollectTriggerResponseSchema,
} from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock session authentication
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

const mockScheduleControl = {
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  describeSchedule: vi.fn(),
  triggerSchedule: vi.fn(),
  listScheduleIds: vi.fn(),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    scheduleControl: mockScheduleControl,
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    config: {
      unhandledErrorPolicy: "rethrow",
    },
  })),
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/attribution/epochs/collect/route";

const SCHEDULE_DESCRIPTION = {
  scheduleId: "governance:ledger_ingest",
  nextRunAtIso: "2026-03-08T06:00:00.000Z",
  lastRunAtIso: "2026-03-07T06:00:00.000Z",
  isPaused: false,
  cron: null,
  timezone: "UTC",
  input: null,
  dbScheduleId: null,
};

describe("POST /api/v1/attribution/epochs/collect", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    mockScheduleControl.describeSchedule.mockResolvedValue(
      SCHEDULE_DESCRIPTION
    );
    mockScheduleControl.triggerSchedule.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(401);
        expect(mockScheduleControl.triggerSchedule).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 404 when schedule does not exist", async () => {
    mockScheduleControl.describeSchedule.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain("LEDGER_INGEST");
        expect(mockScheduleControl.triggerSchedule).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 429 when within cooldown period", async () => {
    const recentRun = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    mockScheduleControl.describeSchedule.mockResolvedValue({
      ...SCHEDULE_DESCRIPTION,
      lastRunAtIso: recentRun,
    });

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(429);
        const body = await res.json();
        const parsed = CollectTriggerCooldownResponseSchema.parse(body);
        expect(parsed.error).toBe("cooldown");
        expect(parsed.retryAfterSeconds).toBeGreaterThan(0);
        expect(parsed.retryAfterSeconds).toBeLessThanOrEqual(300);
        expect(mockScheduleControl.triggerSchedule).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 200 with contract-valid response on success", async () => {
    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(200);
        const body = await res.json();
        const parsed = CollectTriggerResponseSchema.parse(body);
        expect(parsed).toEqual({
          triggered: true,
          scheduleId: "governance:ledger_ingest",
        });
        expect(mockScheduleControl.triggerSchedule).toHaveBeenCalledWith(
          "governance:ledger_ingest"
        );
      },
    });
  });

  it("allows trigger when lastRunAtIso is null (never run)", async () => {
    mockScheduleControl.describeSchedule.mockResolvedValue({
      ...SCHEDULE_DESCRIPTION,
      lastRunAtIso: null,
    });

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(200);
        expect(mockScheduleControl.triggerSchedule).toHaveBeenCalledTimes(1);
      },
    });
  });
});
