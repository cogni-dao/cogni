// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/scheduling/schedules-crud.stack`
 * Purpose: Verify schedule CRUD endpoints with mocked auth.
 * Scope: Tests auth-protected schedule routes via our tables (schedules, grants). Does not test worker execution or job queue internals.
 * Invariants:
 *   - Schedule ownership scoped to caller
 *   - createSchedule creates grant + schedule + enqueues job atomically
 *   - Disabled schedules have nextRunAt = null
 * Side-effects: IO (database, job queue)
 * Links: /api/v1/schedules, docs/spec/scheduler.md
 * @public
 */

import {
  schedulesCreateOperation,
  schedulesListOperation,
} from "@cogni/node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  createSchedulePayload,
  createScheduleUpdatePayload,
  INVALID_PAYLOADS,
} from "@tests/_fixtures/scheduling/fixtures";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { DELETE, PATCH } from "@/app/api/v1/schedules/[scheduleId]/route";
import { GET, POST } from "@/app/api/v1/schedules/route";
import { executionGrants, schedules, users } from "@/shared/db";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

/**
 * Schedule CRUD tests run against real Temporal infrastructure.
 * Requires: temporal, temporal-postgres services running (pnpm dev:infra:test)
 * Tests create real Temporal schedules via TemporalScheduleControlAdapter.
 */
describe("[scheduling] schedules CRUD", () => {
  let testActor: TestActor;

  beforeEach(async () => {
    // Seed user + billing account directly (no accountService indirection)
    const db = getSeedDb();
    testActor = await seedTestActor(db);
    vi.mocked(getSessionUser).mockResolvedValue(testActor.user);
  });

  afterEach(async () => {
    // Cleanup: Delete schedules via API first (cleans up Temporal + DB)
    // Then delete user (cascades remaining DB records via FK)
    const db = getSeedDb();

    // Find all schedules for this user and delete via API
    const userSchedules = await db.query.schedules.findMany({
      where: eq(schedules.ownerUserId, testActor.user.id),
    });

    for (const schedule of userSchedules) {
      const deleteRequest = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${schedule.id}`,
        { method: "DELETE" }
      );
      await DELETE(deleteRequest, {
        params: Promise.resolve({ scheduleId: schedule.id }),
      });
    }

    // Now delete user (cascades billing_accounts, grants via FK)
    await db.delete(users).where(eq(users.id, testActor.user.id));

    vi.clearAllMocks();
    // Don't resetContainer() here - reuse Temporal connection across tests
  });

  describe("POST /api/v1/schedules", () => {
    test("creates schedule and returns 201", async () => {
      const payload = createSchedulePayload();

      const request = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await POST(request);

      expect(response.status).toBe(201);

      const body = await response.json();
      const parsed = schedulesCreateOperation.output.safeParse(body);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.graphId).toBe(payload.graphId);
        expect(parsed.data.cron).toBe(payload.cron);
        expect(parsed.data.enabled).toBe(true);
        expect(parsed.data.nextRunAt).not.toBeNull();
      }
    });

    test("creates grant in database (T3: DB assertion)", async () => {
      const payload = createSchedulePayload();

      const request = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await POST(request);
      const body = await response.json();

      // Verify grant exists in DB
      const db = getSeedDb();
      const scheduleRow = await db.query.schedules.findFirst({
        where: eq(schedules.id, body.id),
      });
      expect(scheduleRow).toBeDefined();
      expect(scheduleRow?.executionGrantId).toBeDefined();

      const grantRow = await db.query.executionGrants.findFirst({
        where: eq(executionGrants.id, scheduleRow?.executionGrantId ?? ""),
      });
      expect(grantRow).toBeDefined();
      expect(grantRow?.userId).toBe(testActor.user.id);
      expect(grantRow?.billingAccountId).toBe(testActor.billingAccountId);
      expect(grantRow?.scopes).toContain(`graph:execute:${payload.graphId}`);
    });

    test("returns 400 for invalid cron", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(INVALID_PAYLOADS.invalidCron),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid cron");
    });

    test("returns 400 for invalid timezone", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(INVALID_PAYLOADS.invalidTimezone),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid timezone");
    });
  });

  describe("GET /api/v1/schedules", () => {
    test("returns empty list when no schedules", async () => {
      const request = new NextRequest("http://localhost:3000/api/v1/schedules");
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      const parsed = schedulesListOperation.output.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.schedules).toHaveLength(0);
      }
    });

    test("returns created schedules", async () => {
      // Create a schedule first
      const createRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(createSchedulePayload()),
          headers: { "Content-Type": "application/json" },
        }
      );
      await POST(createRequest);

      // List schedules
      const listRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules"
      );
      const response = await GET(listRequest);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.schedules).toHaveLength(1);
    });
  });

  describe("PATCH /api/v1/schedules/[scheduleId]", () => {
    test("disables schedule and sets nextRunAt to null", async () => {
      // Create schedule
      const createRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(createSchedulePayload()),
          headers: { "Content-Type": "application/json" },
        }
      );
      const createResponse = await POST(createRequest);
      const created = await createResponse.json();

      // Disable it
      const updatePayload = createScheduleUpdatePayload({ enabled: false });
      const updateRequest = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${created.id}`,
        {
          method: "PATCH",
          body: JSON.stringify(updatePayload),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await PATCH(updateRequest, {
        params: Promise.resolve({ scheduleId: created.id }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.enabled).toBe(false);
      expect(body.nextRunAt).toBeNull();
    });

    test("re-enables schedule and seeds nextRunAt", async () => {
      // Create and disable
      const createRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(createSchedulePayload()),
          headers: { "Content-Type": "application/json" },
        }
      );
      const createResponse = await POST(createRequest);
      const created = await createResponse.json();

      // Disable
      const disableRequest = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${created.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
          headers: { "Content-Type": "application/json" },
        }
      );
      await PATCH(disableRequest, {
        params: Promise.resolve({ scheduleId: created.id }),
      });

      // Re-enable
      const enableRequest = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${created.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: true }),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await PATCH(enableRequest, {
        params: Promise.resolve({ scheduleId: created.id }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.enabled).toBe(true);
      expect(body.nextRunAt).not.toBeNull();
    });

    test("returns 404 for non-existent schedule", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const request = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${fakeId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
          headers: { "Content-Type": "application/json" },
        }
      );
      const response = await PATCH(request, {
        params: Promise.resolve({ scheduleId: fakeId }),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/schedules/[scheduleId]", () => {
    test("deletes schedule and returns 204", async () => {
      // Create schedule
      const createRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules",
        {
          method: "POST",
          body: JSON.stringify(createSchedulePayload()),
          headers: { "Content-Type": "application/json" },
        }
      );
      const createResponse = await POST(createRequest);
      const created = await createResponse.json();

      // Delete it
      const deleteRequest = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${created.id}`,
        { method: "DELETE" }
      );
      const response = await DELETE(deleteRequest, {
        params: Promise.resolve({ scheduleId: created.id }),
      });

      expect(response.status).toBe(204);

      // Verify schedule is gone
      const listRequest = new NextRequest(
        "http://localhost:3000/api/v1/schedules"
      );
      const listResponse = await GET(listRequest);
      const listBody = await listResponse.json();
      expect(listBody.schedules).toHaveLength(0);
    });

    test("returns 404 for non-existent schedule", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const request = new NextRequest(
        `http://localhost:3000/api/v1/schedules/${fakeId}`,
        { method: "DELETE" }
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ scheduleId: fakeId }),
      });

      expect(response.status).toBe(404);
    });
  });
});
