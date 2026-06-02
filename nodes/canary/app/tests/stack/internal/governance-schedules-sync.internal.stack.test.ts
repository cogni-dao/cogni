// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/internal/governance-schedules-sync.internal.stack`
 * Purpose: End-to-end stack test for internal governance schedules sync endpoint.
 * Scope: Calls POST /api/internal/ops/governance/schedules/sync and verifies grant+schedules were created. Does not test worker execution.
 * Invariants:
 *   - INTERNAL_OPS_AUTH: Bearer token required
 *   - JOB_DELEGATION_ONLY: Endpoint delegates to bootstrap job
 *   - TEMPORAL_SCHEDULES_CREATED: Governance schedules appear in Temporal after call
 * Side-effects: IO (HTTP route execution, DB writes, Temporal schedule CRUD)
 * Notes: Requires stack test environment with DB + Temporal available.
 * Links: src/app/api/internal/ops/governance/schedules/sync/route.ts
 * @public
 */

import { executionGrants } from "@cogni/db-schema";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { getTestTemporalClient } from "@tests/_fixtures/temporal/client";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/internal/ops/governance/schedules/sync/route";

const INTERNAL_OPS_TOKEN =
  process.env.INTERNAL_OPS_TOKEN ?? "test-internal-ops-token-min-32-chars";

function createRequest(token?: string): NextRequest {
  const headers: HeadersInit = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  return new NextRequest(
    "http://localhost:3000/api/internal/ops/governance/schedules/sync",
    {
      method: "POST",
      headers,
    }
  );
}

describe("[internal] POST /api/internal/ops/governance/schedules/sync", () => {
  const createdScheduleIds: string[] = [];

  beforeEach(async () => {
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test");
    }

    process.env.INTERNAL_OPS_TOKEN = INTERNAL_OPS_TOKEN;

    const client = await getTestTemporalClient();
    for await (const summary of client.schedule.list()) {
      if (summary.scheduleId.startsWith("governance:")) {
        try {
          await client.schedule.getHandle(summary.scheduleId).delete();
        } catch {
          // ignore already-deleted/race
        }
      }
    }

    const db = getSeedDb();
    await db
      .delete(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
  });

  afterEach(async () => {
    const client = await getTestTemporalClient();
    for (const scheduleId of createdScheduleIds) {
      try {
        await client.schedule.getHandle(scheduleId).delete();
      } catch {
        // ignore already-deleted/race
      }
    }
    createdScheduleIds.length = 0;

    const db = getSeedDb();
    await db
      .delete(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
  });

  it("returns 401 when Authorization header is missing", async () => {
    const response = await POST(createRequest());
    expect(response.status).toBe(401);
  });

  it("creates governance schedules in Temporal via endpoint", async () => {
    const response = await POST(createRequest(INTERNAL_OPS_TOKEN));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      created: number;
      resumed: number;
      skipped: number;
      paused: number;
    };
    expect(body.created).toBeGreaterThanOrEqual(1);
    expect(body.resumed).toBeGreaterThanOrEqual(0);
    expect(body.skipped).toBeGreaterThanOrEqual(0);
    expect(body.paused).toBeGreaterThanOrEqual(0);

    const db = getSeedDb();
    const grants = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));

    expect(grants).toHaveLength(1);
    expect(grants[0]?.billingAccountId).toBe(COGNI_SYSTEM_BILLING_ACCOUNT_ID);
    expect(grants[0]?.scopes).toContain("graph:execute:sandbox:openclaw");

    // Use getHandle directly — schedule.list() has eventual consistency
    // and may not reflect a just-created schedule immediately
    const client = await getTestTemporalClient();
    const handle = client.schedule.getHandle("governance:heartbeat");
    const desc = await handle.describe();
    expect(desc).toBeDefined();
    createdScheduleIds.push("governance:heartbeat");
  });
});
