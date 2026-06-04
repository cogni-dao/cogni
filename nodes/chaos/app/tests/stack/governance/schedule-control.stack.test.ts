// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/governance/schedule-control.contract`
 * Purpose: Contract test for ScheduleControlPort.listScheduleIds.
 * Scope: Verifies listScheduleIds filters by prefix correctly. Does not test schedule creation or execution.
 * Invariants: PREFIX_FILTERING (only returns schedules matching prefix)
 * Side-effects: IO
 * Links: src/adapters/server/temporal/schedule-control.adapter.ts
 * @public
 */

import {
  getTestTemporalClient,
  getTestTemporalConfig,
} from "@tests/_fixtures/temporal/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemporalScheduleControlAdapter } from "@/adapters/server/temporal/schedule-control.adapter";

describe("ScheduleControlPort.listScheduleIds (Contract)", () => {
  let adapter: TemporalScheduleControlAdapter;
  const createdScheduleIds: string[] = [];

  beforeEach(async () => {
    const client = await getTestTemporalClient();
    adapter = new TemporalScheduleControlAdapter(getTestTemporalConfig());

    // Clean up any existing test schedules
    for await (const summary of client.schedule.list()) {
      if (
        summary.scheduleId.startsWith("test-governance:") ||
        summary.scheduleId.startsWith("test-other:")
      ) {
        try {
          await client.schedule.getHandle(summary.scheduleId).delete();
        } catch {
          // Schedule may have running execution or already deleted
        }
      }
    }
  });

  afterEach(async () => {
    // Clean up created schedules
    const client = await getTestTemporalClient();
    for (const scheduleId of createdScheduleIds) {
      try {
        await client.schedule.getHandle(scheduleId).delete();
      } catch {
        // Schedule may have been deleted already
      }
    }
    createdScheduleIds.length = 0;
  });

  async function createTestSchedule(scheduleId: string): Promise<void> {
    const client = await getTestTemporalClient();
    await client.schedule.create({
      scheduleId,
      spec: {
        cronExpressions: ["0 * * * *"],
        timezone: "UTC",
      },
      action: {
        type: "startWorkflow",
        workflowType: "GraphRunWorkflow",
        workflowId: scheduleId,
        args: [{ scheduleId, input: { message: "TEST" } }],
        taskQueue: "scheduler-worker",
      },
    });
    createdScheduleIds.push(scheduleId);
  }

  async function waitForScheduleListed(
    scheduleId: string,
    timeoutMs = 3_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const allIds = await adapter.listScheduleIds("");
      if (allIds.includes(scheduleId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for schedule to appear: ${scheduleId}`);
  }

  it("returns only schedules matching prefix", async () => {
    // Create schedules with different prefixes
    await createTestSchedule("test-governance:charter1");
    await createTestSchedule("test-governance:charter2");
    await createTestSchedule("test-other:schedule");
    await waitForScheduleListed("test-governance:charter1");
    await waitForScheduleListed("test-governance:charter2");
    await waitForScheduleListed("test-other:schedule");

    // List with governance prefix
    const governanceIds = await adapter.listScheduleIds("test-governance:");

    expect(governanceIds).toHaveLength(2);
    expect(governanceIds).toContain("test-governance:charter1");
    expect(governanceIds).toContain("test-governance:charter2");
    expect(governanceIds).not.toContain("test-other:schedule");
  });

  it("returns empty array when no schedules match prefix", async () => {
    await createTestSchedule("test-other:schedule");
    await waitForScheduleListed("test-other:schedule");

    const governanceIds = await adapter.listScheduleIds("test-governance:");

    expect(governanceIds).toEqual([]);
  });

  it("returns all schedules when prefix is empty", async () => {
    await createTestSchedule("test-governance:charter1");
    await createTestSchedule("test-other:schedule");
    await waitForScheduleListed("test-governance:charter1");
    await waitForScheduleListed("test-other:schedule");

    const allIds = await adapter.listScheduleIds("");

    // Should include both test schedules (and possibly others)
    expect(allIds).toContain("test-governance:charter1");
    expect(allIds).toContain("test-other:schedule");
  });

  it("handles schedule IDs with special characters", async () => {
    await createTestSchedule("test-governance:charter-with-dash");
    await createTestSchedule("test-governance:charter_with_underscore");
    await waitForScheduleListed("test-governance:charter-with-dash");
    await waitForScheduleListed("test-governance:charter_with_underscore");

    const ids = await adapter.listScheduleIds("test-governance:");

    expect(ids).toHaveLength(2);
    expect(ids).toContain("test-governance:charter-with-dash");
    expect(ids).toContain("test-governance:charter_with_underscore");
  });
});
