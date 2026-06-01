// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/scheduling/scheduler-worker-execution.stack`
 * Purpose: Verify scheduler-worker executes workflows and creates ledger records.
 * Scope: Tests end-to-end flow: Schedule create → Temporal trigger → Worker runs → DB records created. Does not test CRUD operations (covered elsewhere).
 * Invariants:
 *   - Per RUN_LEDGER_FOR_GOVERNANCE: graph_runs record created for each slot
 *   - Per EXECUTION_IDEMPOTENCY_PERSISTED: execution_requests record created
 *   - Per SLOT_IDEMPOTENCY_VIA_EXECUTION_REQUESTS: idempotency_key = scheduleId:scheduledFor
 * Side-effects: IO (database, Temporal, internal API via worker)
 * Notes: Requires full stack running (pnpm dev:stack:test) including scheduler-worker.
 * Links: docs/spec/scheduler.md, services/scheduler-worker/
 * @public
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  getExecutionRequest,
  getScheduleRuns,
  waitForScheduleRunCompleted,
} from "@tests/_fixtures/scheduling/db-helpers";
import { createSchedulePayload } from "@tests/_fixtures/scheduling/fixtures";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { triggerSchedule } from "@tests/_fixtures/temporal/client";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { DELETE } from "@/app/api/v1/schedules/[scheduleId]/route";
import { POST } from "@/app/api/v1/schedules/route";
import { users } from "@/shared/db/schema";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

/**
 * Scheduler worker execution tests.
 * Requires: Full stack with scheduler-worker running (pnpm dev:stack:test)
 *
 * Tests the complete flow:
 * 1. Create schedule via CRUD API
 * 2. Trigger schedule via Temporal
 * 3. Worker executes workflow
 * 4. Assert DB records created correctly
 */
describe("[scheduling] scheduler-worker execution", () => {
  let testActor: TestActor;
  let createdScheduleId: string | null = null;

  beforeEach(async () => {
    // Ensure test mode
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test (mock-LLM backend)");
    }

    const db = getSeedDb();
    testActor = await seedTestActor(db);
    vi.mocked(getSessionUser).mockResolvedValue(testActor.user);
  });

  afterEach(async () => {
    const db = getSeedDb();

    // Cleanup: Delete schedule via API (cleans up Temporal + DB)
    if (createdScheduleId) {
      try {
        const deleteRequest = new NextRequest(
          `http://localhost:3000/api/v1/schedules/${createdScheduleId}`,
          { method: "DELETE" }
        );
        await DELETE(deleteRequest, {
          params: Promise.resolve({ scheduleId: createdScheduleId }),
        });
      } catch {
        // Ignore cleanup errors
      }
      createdScheduleId = null;
    }

    // Delete user (cascades billing_accounts, grants via FK)
    await db.delete(users).where(eq(users.id, testActor.user.id));

    vi.clearAllMocks();
  });

  it("creates graph_runs and execution_requests when triggered", async () => {
    // 1. Create schedule via CRUD API
    const payload = createSchedulePayload({
      graphId: "langgraph:poet",
      cron: "0 0 1 1 *", // Far future (Jan 1 at midnight) - won't auto-fire
    });

    const createRequest = new NextRequest(
      "http://localhost:3000/api/v1/schedules",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      }
    );
    const createResponse = await POST(createRequest);
    expect(createResponse.status).toBe(201);

    const created = await createResponse.json();
    createdScheduleId = created.id;
    expect(createdScheduleId).toBeDefined();

    // Type guard after assertion - createdScheduleId is now known to be defined
    if (!createdScheduleId) {
      throw new Error(
        "createdScheduleId should be defined after successful creation"
      );
    }

    // 2. Trigger schedule via Temporal (fires the workflow immediately)
    await triggerSchedule(createdScheduleId);

    // 3. Wait for graph_runs row to be created and reach terminal status
    const scheduleRun = await waitForScheduleRunCompleted(createdScheduleId);

    // 4. Assert graph_runs record
    expect(scheduleRun.scheduleId).toBe(createdScheduleId);
    expect(scheduleRun.scheduledFor).toBeDefined();
    expect(["success", "error"]).toContain(scheduleRun.status);
    expect(scheduleRun.runId).toBeDefined();

    // 5. Verify exactly 1 graph_runs row for this schedule
    const allRuns = await getScheduleRuns(createdScheduleId);
    expect(allRuns.length).toBe(1);

    // 6. Assert execution_requests record exists with correct idempotency key
    // Key format: scheduleId:scheduledFor (ISO string)
    const scheduledForIso = scheduleRun.scheduledFor.toISOString();
    const expectedIdempotencyKey = `${createdScheduleId}:${scheduledForIso}`;

    const executionRequest = await getExecutionRequest(expectedIdempotencyKey);
    expect(executionRequest).not.toBeNull();
    expect(executionRequest?.runId).toBe(scheduleRun.runId);
    expect(executionRequest?.ok).toBe(true);
  });
});
