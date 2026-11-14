#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/debug-governance-schedules`
 * Purpose: Debug script to inspect governance schedules in the database.
 * Scope: One-off diagnostic tool for governance schedule state. Does not modify data.
 * Invariants: Read-only — never mutates schedule data.
 * Side-effects: IO (reads DB, logs to console)
 * Links: https://node-template.cognidao.org/knowledge/governance-schedule-sync
 * @internal
 */

import { eq } from "drizzle-orm";
import { getAppDb } from "../src/adapters/server/db/client.js";
import { schedules } from "../src/shared/db/schema.js";

const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";

const db = getAppDb();

console.log("🔍 Checking schedules for system tenant:", SYSTEM_USER_ID);
console.log("");

const results = await db
  .select({
    id: schedules.id,
    ownerUserId: schedules.ownerUserId,
    enabled: schedules.enabled,
    nextRunAt: schedules.nextRunAt,
    specId: schedules.specId,
  })
  .from(schedules)
  .where(eq(schedules.ownerUserId, SYSTEM_USER_ID));

console.log(`Found ${results.length} schedules:`);
console.log("");

results.forEach((s) => {
  console.log(`  📅 ${s.specId}`);
  console.log(`     enabled: ${s.enabled}`);
  console.log(`     nextRunAt: ${s.nextRunAt || "❌ NULL"}`);
  console.log("");
});

const eligible = results.filter((s) => s.enabled && s.nextRunAt !== null);
console.log(
  `✅ Eligible for display (enabled=true AND nextRunAt!=null): ${eligible.length}`
);

if (eligible.length === 0) {
  console.log("");
  console.log("⚠️  Problem: No schedules have nextRunAt set!");
  console.log("   This means Temporal hasn't scheduled them yet.");
  console.log("");
  console.log("   Possible causes:");
  console.log(
    "   - Schedules were created but Temporal worker hasn't picked them up"
  );
  console.log("   - Temporal connection issue");
  console.log("   - Schedule creation failed silently");
}

process.exit(0);
