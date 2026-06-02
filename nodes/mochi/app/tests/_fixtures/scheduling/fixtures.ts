// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/scheduling/fixtures`
 * Purpose: Reusable test fixtures for scheduling API tests.
 * Scope: Provides factories for schedule payloads and mock session setup. Does not perform database operations.
 * Invariants: All fixtures produce valid contract-compliant data
 * Side-effects: none (pure functions)
 * Links: tests/stack/scheduling/*.stack.test.ts, contracts/schedules.*.v1.contract
 * @public
 */

import { randomUUID } from "node:crypto";

import type { SessionUser } from "@cogni/node-shared";

/**
 * Creates a mock authenticated session user.
 */
export function createMockSessionUser(
  overrides?: Partial<SessionUser>
): SessionUser {
  return {
    id: randomUUID(),
    walletAddress: `0x${randomUUID().replace(/-/g, "").substring(0, 40)}`,
    ...overrides,
  };
}

/**
 * Valid schedule creation payload.
 */
export function createSchedulePayload(overrides?: {
  graphId?: string;
  input?: Record<string, unknown>;
  cron?: string;
  timezone?: string;
}) {
  return {
    graphId: overrides?.graphId ?? "langgraph:poet",
    input: overrides?.input ?? {
      messages: [{ role: "user", content: "Hello" }],
      modelRef: { providerKey: "platform", modelId: "test-model" },
    },
    cron: overrides?.cron ?? "0 9 * * *", // 9am daily
    timezone: overrides?.timezone ?? "UTC",
  };
}

/**
 * Valid schedule update payload.
 */
export function createScheduleUpdatePayload(overrides?: {
  input?: Record<string, unknown>;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
}) {
  return {
    ...(overrides?.input !== undefined && { input: overrides.input }),
    ...(overrides?.cron !== undefined && { cron: overrides.cron }),
    ...(overrides?.timezone !== undefined && { timezone: overrides.timezone }),
    ...(overrides?.enabled !== undefined && { enabled: overrides.enabled }),
  };
}

/**
 * Expected schedule response shape for assertions.
 * All timestamps are ISO strings.
 */
export interface ScheduleResponseFixture {
  id: string;
  graphId: string;
  input: Record<string, unknown>;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates expected response shape from creation input.
 */
export function expectedScheduleResponse(
  input: ReturnType<typeof createSchedulePayload>,
  overrides?: Partial<ScheduleResponseFixture>
): Partial<ScheduleResponseFixture> {
  return {
    graphId: input.graphId,
    input: input.input,
    cron: input.cron,
    timezone: input.timezone,
    enabled: true,
    lastRunAt: null,
    ...overrides,
  };
}

/**
 * Invalid payloads for validation testing.
 */
export const INVALID_PAYLOADS = {
  emptyCron: {
    graphId: "langgraph:poet",
    input: {},
    cron: "",
    timezone: "UTC",
  },
  invalidCron: {
    graphId: "langgraph:poet",
    input: {},
    cron: "not-a-cron",
    timezone: "UTC",
  },
  invalidTimezone: {
    graphId: "langgraph:poet",
    input: {},
    cron: "0 9 * * *",
    timezone: "Fake/Zone",
  },
  missingGraphId: {
    input: {},
    cron: "0 9 * * *",
    timezone: "UTC",
  },
} as const;
