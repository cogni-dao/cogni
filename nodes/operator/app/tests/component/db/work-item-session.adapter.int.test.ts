// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real-Postgres proof that expired work-item claims are safely reclaimable.
 * Links: bug.5136, src/adapters/server/db/work-item-session.adapter.ts
 */
import { randomUUID } from "node:crypto";
import { users } from "@cogni/db-schema/refs";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleWorkItemSessionAdapter } from "@/adapters/server/db/work-item-session.adapter";
import { workItemSessions } from "@/shared/db/work-item-sessions";

const WORK_ITEMS = [
  "bug.5136-expired",
  "bug.5136-fresh",
  "bug.5136-concurrent",
] as const;

const OLD_USER_ID = randomUUID();
const NEW_USER_ID = randomUUID();
const RACING_USER_ID = randomUUID();
const EXPIRED_AT = new Date("2026-10-14T19:00:00.000Z");
const NOW = new Date("2026-10-14T20:00:00.000Z");
const NEXT_DEADLINE = new Date("2026-10-14T20:30:00.000Z");

describe("DrizzleWorkItemSessionAdapter (Component)", () => {
  const db = getSeedDb();
  const adapter = new DrizzleWorkItemSessionAdapter(db);

  beforeAll(async () => {
    await db.insert(users).values([
      { id: OLD_USER_ID, name: "expired-claimant" },
      { id: NEW_USER_ID, name: "new-claimant" },
      { id: RACING_USER_ID, name: "racing-claimant" },
    ]);
  });

  beforeEach(async () => {
    await db
      .delete(workItemSessions)
      .where(inArray(workItemSessions.workItemId, [...WORK_ITEMS]));
  });

  afterAll(async () => {
    await db
      .delete(workItemSessions)
      .where(inArray(workItemSessions.workItemId, [...WORK_ITEMS]));
    await db
      .delete(users)
      .where(inArray(users.id, [OLD_USER_ID, NEW_USER_ID, RACING_USER_ID]));
  });

  async function seedClaim(input: {
    workItemId: (typeof WORK_ITEMS)[number];
    deadlineAt: Date;
  }) {
    const [row] = await db
      .insert(workItemSessions)
      .values({
        workItemId: input.workItemId,
        claimedByUserId: OLD_USER_ID,
        claimedByDisplayName: "expired-claimant",
        deadlineAt: input.deadlineAt,
        lastCommand: "/implement",
      })
      .returning();
    if (!row) throw new Error("failed to seed work-item session");
    return row;
  }

  it("supersedes an expired claim while preserving its audit row", async () => {
    const old = await seedClaim({
      workItemId: "bug.5136-expired",
      deadlineAt: EXPIRED_AT,
    });

    const result = await adapter.claim({
      workItemId: "bug.5136-expired",
      claimedByUserId: NEW_USER_ID,
      claimedByDisplayName: "new-claimant",
      now: NOW,
      deadlineAt: NEXT_DEADLINE,
      lastCommand: "/implement",
    });

    expect(result).toMatchObject({
      kind: "claimed",
      session: {
        claimedByUserId: NEW_USER_ID,
        status: "active",
        deadlineAt: NEXT_DEADLINE,
      },
    });

    const rows = await db
      .select()
      .from(workItemSessions)
      .where(inArray(workItemSessions.workItemId, ["bug.5136-expired"]));
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: old.id,
        claimedByUserId: OLD_USER_ID,
        claimedByDisplayName: "expired-claimant",
        status: "superseded",
        closedAt: NOW,
      })
    );

    await expect(
      adapter.heartbeat({
        workItemId: "bug.5136-expired",
        claimedByUserId: OLD_USER_ID,
        now: NOW,
        deadlineAt: NEXT_DEADLINE,
      })
    ).resolves.toBeNull();
    await expect(
      adapter.linkPr({
        workItemId: "bug.5136-expired",
        claimedByUserId: OLD_USER_ID,
        now: NOW,
        branch: "stale-owner/forbidden",
      })
    ).resolves.toBeNull();
  });

  it("keeps an unexpired foreign claim exclusive", async () => {
    await seedClaim({
      workItemId: "bug.5136-fresh",
      deadlineAt: NEXT_DEADLINE,
    });

    await expect(
      adapter.claim({
        workItemId: "bug.5136-fresh",
        claimedByUserId: NEW_USER_ID,
        claimedByDisplayName: "new-claimant",
        now: NOW,
        deadlineAt: NEXT_DEADLINE,
      })
    ).resolves.toMatchObject({
      kind: "conflict",
      session: { claimedByUserId: OLD_USER_ID, status: "active" },
    });
  });

  it("allows exactly one winner when contributors race to reclaim", async () => {
    await seedClaim({
      workItemId: "bug.5136-concurrent",
      deadlineAt: EXPIRED_AT,
    });

    const results = await Promise.all([
      adapter.claim({
        workItemId: "bug.5136-concurrent",
        claimedByUserId: NEW_USER_ID,
        claimedByDisplayName: "new-claimant",
        now: NOW,
        deadlineAt: NEXT_DEADLINE,
      }),
      adapter.claim({
        workItemId: "bug.5136-concurrent",
        claimedByUserId: RACING_USER_ID,
        claimedByDisplayName: "racing-claimant",
        now: NOW,
        deadlineAt: NEXT_DEADLINE,
      }),
    ]);

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(
      1
    );
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(
      1
    );

    const rows = await db
      .select()
      .from(workItemSessions)
      .where(inArray(workItemSessions.workItemId, ["bug.5136-concurrent"]));
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "superseded")).toHaveLength(1);
  });
});
