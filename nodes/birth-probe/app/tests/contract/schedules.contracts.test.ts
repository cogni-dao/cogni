// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/schedules.contracts`
 * Purpose: Validates schedule Zod schemas match contract spec.
 * Scope: Tests Zod schema compliance for schedule CRUD. Does not test API endpoint behavior.
 * Invariants:
 *   - All response fields validated per contract spec
 *   - nextRunAt nullable (for disabled schedules)
 * Side-effects: none
 * Links: @/contracts/schedules.*.v1.contract
 * @internal
 */

import {
  ScheduleCreateInputSchema,
  ScheduleResponseSchema,
  ScheduleUpdateInputSchema,
  schedulesListOperation,
} from "@cogni/node-contracts";
import {
  createSchedulePayload,
  createScheduleUpdatePayload,
  INVALID_PAYLOADS,
} from "@tests/_fixtures/scheduling/fixtures";
import { describe, expect, it } from "vitest";

describe("schedules.create.v1 contract", () => {
  describe("ScheduleCreateInputSchema", () => {
    it("accepts valid input", () => {
      const payload = createSchedulePayload();
      expect(() => ScheduleCreateInputSchema.parse(payload)).not.toThrow();
    });

    it("rejects empty cron", () => {
      expect(() =>
        ScheduleCreateInputSchema.parse(INVALID_PAYLOADS.emptyCron)
      ).toThrow();
    });

    it("rejects missing graphId", () => {
      expect(() =>
        ScheduleCreateInputSchema.parse(INVALID_PAYLOADS.missingGraphId)
      ).toThrow();
    });
  });

  describe("ScheduleResponseSchema", () => {
    it("accepts enabled schedule with nextRunAt", () => {
      const valid = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        graphId: "langgraph:poet",
        input: { messages: [] },
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        nextRunAt: "2025-01-18T09:00:00.000Z",
        lastRunAt: null,
        createdAt: "2025-01-18T00:00:00.000Z",
        updatedAt: "2025-01-18T00:00:00.000Z",
      };
      expect(() => ScheduleResponseSchema.parse(valid)).not.toThrow();
    });

    it("accepts disabled schedule with null nextRunAt", () => {
      const valid = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        graphId: "langgraph:poet",
        input: {},
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2025-01-18T00:00:00.000Z",
        updatedAt: "2025-01-18T00:00:00.000Z",
      };
      expect(() => ScheduleResponseSchema.parse(valid)).not.toThrow();
    });

    it("rejects invalid UUID", () => {
      const invalid = {
        id: "not-a-uuid",
        graphId: "langgraph:poet",
        input: {},
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2025-01-18T00:00:00.000Z",
        updatedAt: "2025-01-18T00:00:00.000Z",
      };
      expect(() => ScheduleResponseSchema.parse(invalid)).toThrow();
    });
  });
});

describe("schedules.list.v1 contract", () => {
  it("accepts empty schedules array", () => {
    const output = { schedules: [] };
    expect(() => schedulesListOperation.output.parse(output)).not.toThrow();
  });

  it("accepts array of valid schedules", () => {
    const output = {
      schedules: [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          graphId: "langgraph:poet",
          input: {},
          cron: "0 9 * * *",
          timezone: "UTC",
          enabled: true,
          nextRunAt: "2025-01-18T09:00:00.000Z",
          lastRunAt: null,
          createdAt: "2025-01-18T00:00:00.000Z",
          updatedAt: "2025-01-18T00:00:00.000Z",
        },
      ],
    };
    expect(() => schedulesListOperation.output.parse(output)).not.toThrow();
  });
});

describe("schedules.update.v1 contract", () => {
  it("accepts partial update with only enabled", () => {
    const payload = createScheduleUpdatePayload({ enabled: false });
    expect(() => ScheduleUpdateInputSchema.parse(payload)).not.toThrow();
  });

  it("accepts partial update with cron and timezone", () => {
    const payload = createScheduleUpdatePayload({
      cron: "0 10 * * *",
      timezone: "America/New_York",
    });
    expect(() => ScheduleUpdateInputSchema.parse(payload)).not.toThrow();
  });

  it("accepts empty object (no-op update)", () => {
    expect(() => ScheduleUpdateInputSchema.parse({})).not.toThrow();
  });
});
