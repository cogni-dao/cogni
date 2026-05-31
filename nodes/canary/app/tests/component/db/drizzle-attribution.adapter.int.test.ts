// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/drizzle-attribution.adapter.int`
 * Purpose: Component tests for DrizzleAttributionAdapter against real PostgreSQL via testcontainers.
 * Scope: Verifies adapter + DB triggers (RECEIPT_APPEND_ONLY, SELECTION_FREEZE_ON_FINALIZE, ONE_OPEN_EPOCH, RECEIPT_IDEMPOTENT) and cross-epoch dedup (SELECTION_POLICY_AUTHORITY, RECEIPT_SCOPE_AGNOSTIC). Does not test domain logic or routes.
 * Invariants: RECEIPT_APPEND_ONLY, RECEIPT_IDEMPOTENT, SELECTION_FREEZE_ON_FINALIZE, ONE_OPEN_EPOCH, SCOPE_GATED_QUERIES, SELECTION_POLICY_AUTHORITY, RECEIPT_SCOPE_AGNOSTIC
 * Side-effects: IO (database operations via testcontainers)
 * Links: packages/db-client/src/adapters/drizzle-attribution.adapter.ts, packages/attribution-ledger/src/store.ts
 * @public
 */

import {
  EpochNotFoundError,
  EpochNotInReviewError,
  EpochNotOpenError,
} from "@cogni/attribution-ledger";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import {
  epochWindow,
  makeEvaluation,
  makeIngestionReceipt,
  makePoolComponent,
  makeSelection,
  makeSelectionAuto,
  makeUserProjection,
  OTHER_SCOPE_ID,
  TEST_NODE_ID,
  TEST_SCOPE_ID,
  TEST_WEIGHT_CONFIG,
} from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor, type TestActor } from "@tests/_fixtures/stack/seed";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Unwrap DrizzleQueryError → underlying PostgresError message */
function drizzleCause(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error)
    return err.cause.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

describe("DrizzleAttributionAdapter (Component)", () => {
  const db = getSeedDb();
  const adapter = new DrizzleAttributionAdapter(db, TEST_SCOPE_ID);

  let actor: TestActor;

  beforeAll(async () => {
    actor = await seedTestActor(db);
  });

  // No global afterAll cleanup needed — testcontainers PostgreSQL is ephemeral.

  // ── Epochs ────────────────────────────────────────────────────

  describe("epochs", () => {
    let createdEpochId: bigint;

    afterAll(async () => {
      // Ensure no open epoch leaks to subsequent describes
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      if (open) {
        await adapter.closeIngestion(
          open.id,
          [],
          "cleanup-hash",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await adapter.finalizeEpoch(open.id, 0n);
      }
    });

    it("creates an epoch and retrieves it", async () => {
      const window = epochWindow(0);
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...window,
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      createdEpochId = epoch.id;

      expect(epoch.status).toBe("open");
      expect(epoch.nodeId).toBe(TEST_NODE_ID);
      expect(epoch.poolTotalCredits).toBeNull();
      expect(epoch.closedAt).toBeNull();

      const fetched = await adapter.getEpoch(epoch.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(epoch.id);
    });

    it("getOpenEpoch returns the open epoch for the node", async () => {
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      expect(open).not.toBeNull();
      expect(open?.status).toBe("open");
    });

    it("listEpochs returns all epochs for the node", async () => {
      const list = await adapter.listEpochs(TEST_NODE_ID);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.every((e) => e.nodeId === TEST_NODE_ID)).toBe(true);
    });

    it("ONE_OPEN_EPOCH: rejects second open epoch for same node", async () => {
      await expect(
        adapter.createEpoch({
          nodeId: TEST_NODE_ID,
          scopeId: TEST_SCOPE_ID,
          ...epochWindow(1),
          weightConfig: TEST_WEIGHT_CONFIG,
        })
      ).rejects.toThrow();
    });

    it("EPOCH_WINDOW_UNIQUE: rejects duplicate window for same node", async () => {
      // Finalize the open epoch so we can test the window constraint in isolation
      await adapter.closeIngestion(
        createdEpochId,
        [],
        "test-hash",
        "weight-sum-v0",
        "test-wch"
      );
      await adapter.finalizeEpoch(createdEpochId, 10000n);

      await expect(
        adapter.createEpoch({
          nodeId: TEST_NODE_ID,
          scopeId: TEST_SCOPE_ID,
          ...epochWindow(0), // same window as the closed epoch
          weightConfig: TEST_WEIGHT_CONFIG,
        })
      ).rejects.toThrow();
    });

    it("closeIngestion transitions open → review with approvers + approverSetHash", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(2),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      const testApprovers = ["0xaaaa", "0xbbbb"];
      const reviewed = await adapter.closeIngestion(
        epoch.id,
        testApprovers,
        "abc123hash",
        "weight-sum-v0",
        "test-wch"
      );
      expect(reviewed.status).toBe("review");
      expect(reviewed.approverSetHash).toBe("abc123hash");
      expect(reviewed.approvers).toEqual(testApprovers);
    });

    it("finalizeEpoch transitions review → finalized with poolTotal and closedAt", async () => {
      // Find the review epoch we just created
      const list = await adapter.listEpochs(TEST_NODE_ID);
      const review = list.find(
        (e) => e.status === "review" && e.approverSetHash === "abc123hash"
      );
      expect(review).toBeDefined();
      if (!review) throw new Error("Expected review epoch");

      const finalized = await adapter.finalizeEpoch(review.id, 50000n);
      expect(finalized.status).toBe("finalized");
      expect(finalized.poolTotalCredits).toBe(50000n);
      expect(finalized.closedAt).not.toBeNull();
    });

    it("finalizeEpoch on already-finalized epoch returns it (EPOCH_FINALIZE_IDEMPOTENT)", async () => {
      const list = await adapter.listEpochs(TEST_NODE_ID);
      const finalized = list.find(
        (e) => e.status === "finalized" && e.poolTotalCredits === 50000n
      );
      expect(finalized).toBeDefined();

      if (!finalized) throw new Error("Expected finalized epoch");
      const result = await adapter.finalizeEpoch(finalized.id, 99999n);
      expect(result.status).toBe("finalized");
      expect(result.poolTotalCredits).toBe(50000n); // unchanged
    });

    it("finalizeEpoch on non-existent epoch throws EpochNotFoundError", async () => {
      await expect(adapter.finalizeEpoch(999999n, 100n)).rejects.toThrow(
        EpochNotFoundError
      );
    });

    it("finalizeEpoch on open epoch throws EpochNotOpenError (must review first)", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(8),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      await expect(adapter.finalizeEpoch(epoch.id, 100n)).rejects.toThrow(
        EpochNotOpenError
      );

      // Cleanup: transition to finalized so ONE_OPEN_EPOCH doesn't block later tests
      await adapter.closeIngestion(
        epoch.id,
        [],
        "cleanup-hash",
        "weight-sum-v0",
        "cleanup-wch"
      );
      await adapter.finalizeEpoch(epoch.id, 0n);
    });

    it("closeIngestion on finalized epoch returns it idempotently", async () => {
      const list = await adapter.listEpochs(TEST_NODE_ID);
      const finalized = list.find((e) => e.status === "finalized");
      expect(finalized).toBeDefined();
      if (!finalized) throw new Error("Expected finalized epoch");

      const result = await adapter.closeIngestion(
        finalized.id,
        [],
        "should-be-ignored",
        "weight-sum-v0",
        "ignored-wch"
      );
      expect(result.status).toBe("finalized");
      // approverSetHash unchanged — not overwritten
      expect(result.approverSetHash).not.toBe("should-be-ignored");
    });
  });

  // ── Ingestion Receipts ───────────────────────────────────────────

  describe("ingestion receipts", () => {
    it("inserts receipts and retrieves by time window", async () => {
      const events = [
        makeIngestionReceipt({
          receiptId: "github:pr:test/repo:1",
          eventTime: new Date("2026-01-06T10:00:00Z"),
          platformUserId: "111",
        }),
        makeIngestionReceipt({
          receiptId: "github:pr:test/repo:2",
          eventTime: new Date("2026-01-07T10:00:00Z"),
          platformUserId: "222",
        }),
      ];

      await adapter.insertIngestionReceipts(events);

      const results = await adapter.getReceiptsForWindow(
        TEST_NODE_ID,
        new Date("2026-01-06T00:00:00Z"),
        new Date("2026-01-08T00:00:00Z")
      );

      expect(results.length).toBeGreaterThanOrEqual(2);
      const ids = results.map((e) => e.receiptId);
      expect(ids).toContain("github:pr:test/repo:1");
      expect(ids).toContain("github:pr:test/repo:2");
    });

    it("RECEIPT_IDEMPOTENT: re-inserting same receipt is a no-op", async () => {
      const event = makeIngestionReceipt({
        receiptId: "github:pr:test/repo:1",
        platformUserId: "111",
      });

      await adapter.insertIngestionReceipts([event]);

      const results = await adapter.getReceiptsForWindow(
        TEST_NODE_ID,
        new Date("2026-01-06T00:00:00Z"),
        new Date("2026-01-08T00:00:00Z")
      );
      const matching = results.filter(
        (e) => e.receiptId === "github:pr:test/repo:1"
      );
      expect(matching).toHaveLength(1);
    });

    it("RECEIPT_APPEND_ONLY: UPDATE on ingestion_receipts is rejected by trigger", async () => {
      await expect(
        db.execute(
          sql`UPDATE ingestion_receipts SET source = 'modified' WHERE receipt_id = 'github:pr:test/repo:1' AND node_id = ${TEST_NODE_ID}::uuid`
        )
      ).rejects.toSatisfy((err: unknown) =>
        /not allowed/i.test(drizzleCause(err))
      );
    });

    it("RECEIPT_APPEND_ONLY: DELETE on ingestion_receipts is rejected by trigger", async () => {
      await expect(
        db.execute(
          sql`DELETE FROM ingestion_receipts WHERE receipt_id = 'github:pr:test/repo:1' AND node_id = ${TEST_NODE_ID}::uuid`
        )
      ).rejects.toSatisfy((err: unknown) =>
        /not allowed/i.test(drizzleCause(err))
      );
    });
  });

  // ── Selection ──────────────────────────────────────────────────

  describe("selection", () => {
    let epochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(3),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epochId = epoch.id;
    });

    // Freeze test finalizes the epoch; afterAll is a safety net
    afterAll(async () => {
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      if (open) {
        await adapter.closeIngestion(
          open.id,
          [],
          "cleanup-hash",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await adapter.finalizeEpoch(open.id, 0n);
      }
    });

    it("upserts selection entries and retrieves them", async () => {
      await adapter.upsertSelection([
        makeSelection({
          epochId,
          receiptId: "github:pr:test/repo:1",
          userId: actor.user.id,
        }),
        makeSelection({
          epochId,
          receiptId: "github:pr:test/repo:2",
          userId: null,
        }),
      ]);

      const all = await adapter.getSelectionForEpoch(epochId);
      expect(all).toHaveLength(2);
    });

    it("getUnresolvedSelection returns only entries with null userId", async () => {
      const unresolved = await adapter.getUnresolvedSelection(epochId);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.receiptId).toBe("github:pr:test/repo:2");
    });

    it("upsert updates existing selection (same epoch+receipt)", async () => {
      await adapter.upsertSelection([
        makeSelection({
          epochId,
          receiptId: "github:pr:test/repo:2",
          userId: actor.user.id,
        }),
      ]);

      const unresolved = await adapter.getUnresolvedSelection(epochId);
      expect(unresolved).toHaveLength(0);
    });

    it("SELECTION_FREEZE_ON_FINALIZE: selection is mutable during review", async () => {
      await adapter.closeIngestion(
        epochId,
        [],
        "review-curation-test",
        "weight-sum-v0",
        "review-wch"
      );

      // Selection writes should succeed while epoch is in review
      await expect(
        adapter.upsertSelection([
          makeSelection({
            epochId,
            receiptId: "github:pr:test/repo:1",
            userId: actor.user.id,
            note: "updated during review",
          }),
        ])
      ).resolves.not.toThrow();
    });

    it("SELECTION_FREEZE_ON_FINALIZE: rejects selection writes after epoch finalize", async () => {
      // Epoch is already in review from the previous test
      await adapter.finalizeEpoch(epochId, 5000n);

      await expect(
        adapter.upsertSelection([
          makeSelection({
            epochId,
            receiptId: "github:pr:test/repo:1",
            userId: null,
            note: "should fail",
          }),
        ])
      ).rejects.toSatisfy((err: unknown) =>
        /finalized/i.test(drizzleCause(err))
      );
    });
  });

  // ── getSelectedReceiptsForAllocation ─────────────────────────────

  describe("getSelectedReceiptsForAllocation", () => {
    let epochId: bigint;
    let resolvedActor: TestActor;

    beforeAll(async () => {
      resolvedActor = await seedTestActor(db);

      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(31),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epochId = epoch.id;

      // Insert ingestion receipts within epoch window
      const eventTime = new Date("2026-08-20T12:00:00Z");
      await adapter.insertIngestionReceipts([
        makeIngestionReceipt({
          receiptId: "join-test:resolved",
          eventTime,
          platformUserId: "gh-resolved",
          source: "github",
          eventType: "pr_merged",
        }),
        makeIngestionReceipt({
          receiptId: "join-test:unresolved",
          eventTime,
          platformUserId: "gh-unresolved",
          source: "github",
          eventType: "review_submitted",
        }),
        makeIngestionReceipt({
          receiptId: "join-test:excluded",
          eventTime,
          platformUserId: "gh-excluded",
          source: "github",
          eventType: "pr_merged",
        }),
      ]);

      // Select: one resolved, one unresolved (null userId), one excluded
      await adapter.upsertSelection([
        makeSelection({
          epochId,
          receiptId: "join-test:resolved",
          userId: resolvedActor.user.id,
          included: true,
        }),
        makeSelection({
          epochId,
          receiptId: "join-test:unresolved",
          userId: null,
          included: true,
        }),
        makeSelection({
          epochId,
          receiptId: "join-test:excluded",
          userId: resolvedActor.user.id,
          included: false,
        }),
      ]);
    });

    afterAll(async () => {
      await adapter.closeIngestion(
        epochId,
        [],
        "cleanup-hash",
        "weight-sum-v0",
        "cleanup-wch"
      );
      await adapter.finalizeEpoch(epochId, 0n);
    });

    it("returns all selections including unresolved (null userId)", async () => {
      const events = await adapter.getSelectedReceiptsForAllocation(epochId);

      // "resolved" has userId set → included
      // "unresolved" has userId=null → included (identity claimants need weights too)
      // "excluded" has userId set but included=false → still returned (filtering is domain logic)
      const receiptIds = events.map((e) => e.receiptId);
      expect(receiptIds).toContain("join-test:resolved");
      expect(receiptIds).toContain("join-test:excluded");
      expect(receiptIds).toContain("join-test:unresolved");

      const unresolved = events.find(
        (e) => e.receiptId === "join-test:unresolved"
      );
      expect(unresolved?.userId).toBeNull();
    });

    it("join populates source and eventType from ingestion_receipts", async () => {
      const events = await adapter.getSelectedReceiptsForAllocation(epochId);
      const resolved = events.find((e) => e.receiptId === "join-test:resolved");

      expect(resolved).toBeDefined();
      expect(resolved?.source).toBe("github");
      expect(resolved?.eventType).toBe("pr_merged");
      expect(resolved?.userId).toBe(resolvedActor.user.id);
    });

    it("getSelectedReceiptsForAttribution keeps unresolved rows for later attribution", async () => {
      const claims = await adapter.getSelectedReceiptsForAttribution(epochId);

      const receiptIds = claims.map((claim) => claim.receiptId);
      expect(receiptIds).toContain("join-test:resolved");
      expect(receiptIds).toContain("join-test:unresolved");
      expect(receiptIds).toContain("join-test:excluded");

      const unresolved = claims.find(
        (claim) => claim.receiptId === "join-test:unresolved"
      );
      expect(unresolved?.userId).toBeNull();
      expect(unresolved?.platformUserId).toBe("gh-unresolved");
      expect(unresolved?.eventType).toBe("review_submitted");
    });
  });

  // ── User Projections ──────────────────────────────────────────

  describe("user projections", () => {
    let epochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(4),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epochId = epoch.id;
    });

    afterAll(async () => {
      await adapter.closeIngestion(
        epochId,
        [],
        "cleanup-hash",
        "weight-sum-v0",
        "cleanup-wch"
      );
      await adapter.finalizeEpoch(epochId, 0n);
    });

    it("inserts user projections and retrieves them", async () => {
      await adapter.insertUserProjections([
        makeUserProjection({
          epochId,
          userId: actor.user.id,
          projectedUnits: 8000n,
          receiptCount: 3,
        }),
      ]);

      const projections = await adapter.getUserProjectionsForEpoch(epochId);
      expect(projections).toHaveLength(1);
      expect(projections[0]?.projectedUnits).toBe(8000n);
      expect(projections[0]?.receiptCount).toBe(3);
    });

    it("upsertUserProjections updates projected units on conflict", async () => {
      await adapter.upsertUserProjections([
        makeUserProjection({
          epochId,
          userId: actor.user.id,
          projectedUnits: 99999n,
          receiptCount: 10,
        }),
      ]);

      const projections = await adapter.getUserProjectionsForEpoch(epochId);
      const projection = projections.find((p) => p.userId === actor.user.id);
      expect(projection).toBeDefined();
      expect(projection?.projectedUnits).toBe(99999n);
      expect(projection?.receiptCount).toBe(10);
    });

    it("deleteStaleUserProjections removes rows not in the active set", async () => {
      // Seed two more users
      const actorB = await seedTestActor(db);
      const actorC = await seedTestActor(db);

      await adapter.insertUserProjections([
        makeUserProjection({
          epochId,
          userId: actorB.user.id,
          projectedUnits: 2000n,
          receiptCount: 1,
        }),
        makeUserProjection({
          epochId,
          userId: actorC.user.id,
          projectedUnits: 3000n,
          receiptCount: 1,
        }),
      ]);

      await adapter.deleteStaleUserProjections(epochId, [actor.user.id]);

      const projections = await adapter.getUserProjectionsForEpoch(epochId);
      const userIds = projections.map((p) => p.userId);

      expect(userIds).toContain(actor.user.id);
      expect(userIds).not.toContain(actorB.user.id);
      expect(userIds).not.toContain(actorC.user.id);
    });
  });

  // ── Cursors ───────────────────────────────────────────────────

  describe("cursors", () => {
    it("upserts and retrieves a cursor", async () => {
      await adapter.upsertCursor(
        TEST_NODE_ID,
        TEST_SCOPE_ID,
        "github",
        "pull_requests",
        "test/repo",
        "2026-01-06T00:00:00Z"
      );

      const cursor = await adapter.getCursor(
        TEST_NODE_ID,
        TEST_SCOPE_ID,
        "github",
        "pull_requests",
        "test/repo"
      );
      expect(cursor).not.toBeNull();
      expect(cursor?.cursorValue).toBe("2026-01-06T00:00:00Z");
    });

    it("upsert updates existing cursor value", async () => {
      await adapter.upsertCursor(
        TEST_NODE_ID,
        TEST_SCOPE_ID,
        "github",
        "pull_requests",
        "test/repo",
        "2026-01-07T00:00:00Z"
      );

      const cursor = await adapter.getCursor(
        TEST_NODE_ID,
        TEST_SCOPE_ID,
        "github",
        "pull_requests",
        "test/repo"
      );
      expect(cursor?.cursorValue).toBe("2026-01-07T00:00:00Z");
    });

    it("getCursor returns null for unknown cursor", async () => {
      const cursor = await adapter.getCursor(
        TEST_NODE_ID,
        TEST_SCOPE_ID,
        "github",
        "unknown_stream",
        "test/repo"
      );
      expect(cursor).toBeNull();
    });
  });

  // ── Pool Components ───────────────────────────────────────────

  describe("pool components", () => {
    let epochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(5),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epochId = epoch.id;
    });

    afterAll(async () => {
      await adapter.closeIngestion(
        epochId,
        [],
        "cleanup-hash",
        "weight-sum-v0",
        "cleanup-wch"
      );
      await adapter.finalizeEpoch(epochId, 0n);
    });

    it("inserts and retrieves pool components", async () => {
      const { component: comp, created } = await adapter.insertPoolComponent(
        makePoolComponent({ epochId })
      );

      expect(created).toBe(true);
      expect(comp.componentId).toBe("base_issuance");
      expect(comp.amountCredits).toBe(10000n);

      const all = await adapter.getPoolComponentsForEpoch(epochId);
      expect(all).toHaveLength(1);
    });

    it("POOL_UNIQUE_PER_TYPE: duplicate insert is idempotent, returns existing", async () => {
      const { component: existing, created } =
        await adapter.insertPoolComponent(makePoolComponent({ epochId }));

      expect(created).toBe(false);
      expect(existing.componentId).toBe("base_issuance");
      expect(existing.amountCredits).toBe(10000n);

      // Still only one row
      const all = await adapter.getPoolComponentsForEpoch(epochId);
      expect(all).toHaveLength(1);
    });

    it("POOL_IMMUTABLE: UPDATE on pool components is rejected by trigger", async () => {
      await expect(
        db.execute(
          sql`UPDATE epoch_pool_components SET amount_credits = 99999 WHERE epoch_id = ${epochId}`
        )
      ).rejects.toSatisfy((err: unknown) =>
        /not allowed/i.test(drizzleCause(err))
      );
    });

    it("POOL_LOCKED_AT_REVIEW: insertPoolComponent rejected after closeIngestion", async () => {
      // Close the describe-level epoch so ONE_OPEN_EPOCH allows a new one
      await adapter.closeIngestion(
        epochId,
        [],
        "pre-review-hash",
        "weight-sum-v0",
        "pre-review-wch"
      );
      await adapter.finalizeEpoch(epochId, 0n);

      const reviewEpoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(30),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        reviewEpoch.id,
        [],
        "pool-lock-hash",
        "weight-sum-v0",
        "pool-lock-wch"
      );

      await expect(
        adapter.insertPoolComponent(
          makePoolComponent({ epochId: reviewEpoch.id })
        )
      ).rejects.toThrow(EpochNotOpenError);

      // Also rejected when finalized
      await adapter.finalizeEpoch(reviewEpoch.id, 0n);
      await expect(
        adapter.insertPoolComponent(
          makePoolComponent({ epochId: reviewEpoch.id })
        )
      ).rejects.toThrow(EpochNotOpenError);
    });
  });

  // ── Epoch Statements ─────────────────────────────────────────

  describe("epoch statements", () => {
    let epochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(6),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "stmt-test-hash",
        "weight-sum-v0",
        "stmt-wch"
      );
      await adapter.finalizeEpoch(epoch.id, 10000n);
      epochId = epoch.id;
    });

    it("inserts and retrieves an epoch statement", async () => {
      const stmt = await adapter.insertEpochStatement({
        nodeId: TEST_NODE_ID,
        epochId,
        finalAllocationSetHash: "abc123def456",
        poolTotalCredits: 10000n,
        statementLines: [
          {
            claimant_key: `user:${actor.user.id}`,
            claimant: { kind: "user", userId: actor.user.id },
            final_units: "8000",
            pool_share: "1.000000",
            credit_amount: "10000",
            receipt_ids: ["github:pr:test/repo:1"],
          },
        ],
      });

      expect(stmt.epochId).toBe(epochId);
      expect(stmt.poolTotalCredits).toBe(10000n);

      const fetched = await adapter.getStatementForEpoch(epochId);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(stmt.id);
    });

    it("getStatementForEpoch throws EpochNotFoundError for non-existent epoch", async () => {
      await expect(adapter.getStatementForEpoch(999999n)).rejects.toThrow(
        EpochNotFoundError
      );
    });
  });

  // ── Statement Signatures ──────────────────────────────────────

  describe("statement signatures", () => {
    let statementId: string;

    beforeAll(async () => {
      // Self-contained: create epoch → close → insert statement
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(7),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "sig-test-hash",
        "weight-sum-v0",
        "sig-wch"
      );
      await adapter.finalizeEpoch(epoch.id, 20000n);

      const stmt = await adapter.insertEpochStatement({
        nodeId: TEST_NODE_ID,
        epochId: epoch.id,
        finalAllocationSetHash: "sig-test-hash",
        poolTotalCredits: 20000n,
        statementLines: [
          {
            claimant_key: "user:sig-test-user",
            claimant: { kind: "user", userId: "sig-test-user" },
            final_units: "20000",
            pool_share: "1.0",
            credit_amount: "20000",
            receipt_ids: ["sig-test-receipt"],
          },
        ],
      });
      statementId = stmt.id;
    });

    it("inserts and retrieves a signature", async () => {
      await adapter.insertStatementSignature({
        nodeId: TEST_NODE_ID,
        statementId,
        signerWallet: "0x1234567890abcdef1234567890abcdef12345678",
        signature: "0xdeadbeef",
        signedAt: new Date(),
      });

      const sigs = await adapter.getSignaturesForStatement(statementId);
      expect(sigs).toHaveLength(1);
      expect(sigs[0]?.signerWallet).toBe(
        "0x1234567890abcdef1234567890abcdef12345678"
      );
    });

    it("insertStatementSignature duplicate is a no-op", async () => {
      // Re-insert the same signature — should not throw
      await expect(
        adapter.insertStatementSignature({
          nodeId: TEST_NODE_ID,
          statementId,
          signerWallet: "0x1234567890abcdef1234567890abcdef12345678",
          signature: "0xdeadbeef",
          signedAt: new Date(),
        })
      ).resolves.not.toThrow();

      const sigs = await adapter.getSignaturesForStatement(statementId);
      expect(sigs).toHaveLength(1);
    });
  });

  // ── finalizeEpochAtomic ──────────────────────────────────────

  describe("finalizeEpochAtomic", () => {
    const SIGNER_WALLET = "0xaaaa000000000000000000000000000000000001";
    const HASH = "atomic-test-hash-abc123";
    const FINAL_CLAIMANT_ALLOCATIONS = [
      {
        nodeId: TEST_NODE_ID,
        epochId: 0n,
        claimantKey: "user:user-1",
        claimant: { kind: "user" as const, userId: "user-1" },
        finalUnits: 8000n,
        receiptIds: ["receipt-1"],
      },
      {
        nodeId: TEST_NODE_ID,
        epochId: 0n,
        claimantKey: "user:user-2",
        claimant: { kind: "user" as const, userId: "user-2" },
        finalUnits: 2000n,
        receiptIds: ["receipt-2"],
      },
    ];
    const STATEMENT_LINES = [
      {
        claimant_key: "user:user-1",
        claimant: { kind: "user" as const, userId: "user-1" },
        final_units: "8000",
        pool_share: "0.800000",
        credit_amount: "8000",
        receipt_ids: ["receipt-1"],
      },
      {
        claimant_key: "user:user-2",
        claimant: { kind: "user" as const, userId: "user-2" },
        final_units: "2000",
        pool_share: "0.200000",
        credit_amount: "2000",
        receipt_ids: ["receipt-2"],
      },
    ];

    function makeAtomicParams(epochId: bigint) {
      return {
        epochId,
        poolTotal: 10000n,
        finalClaimantAllocations: FINAL_CLAIMANT_ALLOCATIONS.map(
          (allocation) => ({
            ...allocation,
            epochId,
          })
        ),
        statement: {
          nodeId: TEST_NODE_ID,
          finalAllocationSetHash: HASH,
          poolTotalCredits: 10000n,
          statementLines: STATEMENT_LINES,
        },
        signature: {
          nodeId: TEST_NODE_ID,
          signerWallet: SIGNER_WALLET,
          signature: "0xsig_aaa",
          signedAt: new Date(),
        },
        expectedFinalAllocationSetHash: HASH,
      };
    }

    it("happy path: review → finalized with statement + signature", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(20),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "atomic-approver-hash",
        "weight-sum-v0",
        "atomic-wch"
      );

      const { epoch: fin, statement } = await adapter.finalizeEpochAtomic(
        makeAtomicParams(epoch.id)
      );

      expect(fin.status).toBe("finalized");
      expect(fin.poolTotalCredits).toBe(10000n);
      expect(fin.closedAt).not.toBeNull();
      expect(statement.finalAllocationSetHash).toBe(HASH);
      expect(statement.poolTotalCredits).toBe(10000n);

      // Signature was created
      const sigs = await adapter.getSignaturesForStatement(statement.id);
      expect(sigs).toHaveLength(1);
      expect(sigs[0]?.signerWallet).toBe(SIGNER_WALLET);
    });

    it("retry: call twice with same inputs — no error, same statement", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(21),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "retry-hash",
        "weight-sum-v0",
        "retry-wch"
      );

      const params = makeAtomicParams(epoch.id);
      const first = await adapter.finalizeEpochAtomic(params);
      const second = await adapter.finalizeEpochAtomic(params);

      expect(first.statement.id).toBe(second.statement.id);
      expect(second.epoch.status).toBe("finalized");
    });

    it("already-finalized + missing signature → signature repaired", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(22),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "repair-hash",
        "weight-sum-v0",
        "repair-wch"
      );

      // First call creates statement + signature for signer A
      const params = makeAtomicParams(epoch.id);
      await adapter.finalizeEpochAtomic(params);

      // Second call with different signer — should add the signature
      const SIGNER_B = "0xbbbb000000000000000000000000000000000002";
      const repairParams = {
        ...params,
        signature: {
          ...params.signature,
          signerWallet: SIGNER_B,
          signature: "0xsig_bbb",
        },
      };
      const { statement } = await adapter.finalizeEpochAtomic(repairParams);

      const sigs = await adapter.getSignaturesForStatement(statement.id);
      expect(sigs).toHaveLength(2);
      const wallets = sigs.map((s) => s.signerWallet).sort();
      expect(wallets).toEqual([SIGNER_WALLET, SIGNER_B].sort());
    });

    it("hash mismatch → throws", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(23),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "hash-mismatch-approver",
        "weight-sum-v0",
        "hash-wch"
      );

      // First call with hash A
      const params = makeAtomicParams(epoch.id);
      await adapter.finalizeEpochAtomic(params);

      // Second call with different expected hash
      const badParams = {
        ...params,
        expectedFinalAllocationSetHash: "different-hash-xyz",
      };
      await expect(adapter.finalizeEpochAtomic(badParams)).rejects.toThrow(
        /finalAllocationSetHash mismatch/
      );
    });

    it("signature divergence → throws", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(24),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      await adapter.closeIngestion(
        epoch.id,
        [],
        "diverge-approver",
        "weight-sum-v0",
        "diverge-wch"
      );

      const params = makeAtomicParams(epoch.id);
      await adapter.finalizeEpochAtomic(params);

      // Same signer, different signature text
      const divergeParams = {
        ...params,
        signature: {
          ...params.signature,
          signature: "0xdifferent_sig",
        },
      };
      await expect(adapter.finalizeEpochAtomic(divergeParams)).rejects.toThrow(
        /signature divergence/
      );
    });

    it("open epoch → throws EpochNotOpenError", async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(25),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      await expect(
        adapter.finalizeEpochAtomic(makeAtomicParams(epoch.id))
      ).rejects.toThrow(EpochNotOpenError);

      // Cleanup
      await adapter.closeIngestion(
        epoch.id,
        [],
        "cleanup",
        "weight-sum-v0",
        "cleanup"
      );
      await adapter.finalizeEpoch(epoch.id, 0n);
    });

    it("missing epoch → throws EpochNotFoundError", async () => {
      await expect(
        adapter.finalizeEpochAtomic(makeAtomicParams(999999n))
      ).rejects.toThrow(EpochNotFoundError);
    });
  });

  // ── SCOPE_GATED_QUERIES ─────────────────────────────────────────

  describe("SCOPE_GATED_QUERIES", () => {
    const otherScopeAdapter = new DrizzleAttributionAdapter(db, OTHER_SCOPE_ID);
    let scopeTestEpochId: bigint;

    beforeAll(async () => {
      // Create epoch in TEST_SCOPE_ID (via the main adapter)
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(10),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      scopeTestEpochId = epoch.id;
    });

    afterAll(async () => {
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      if (open) {
        await adapter.closeIngestion(
          open.id,
          [],
          "cleanup-hash",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await adapter.finalizeEpoch(open.id, 0n);
      }
    });

    it("getEpoch returns null for cross-scope epochId", async () => {
      const result = await otherScopeAdapter.getEpoch(scopeTestEpochId);
      expect(result).toBeNull();
    });

    it("closeIngestion throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.closeIngestion(
          scopeTestEpochId,
          [],
          "test-hash",
          "weight-sum-v0",
          "test-wch"
        )
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("finalizeEpoch throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.finalizeEpoch(scopeTestEpochId, 100n)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getCurationForEpoch throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getSelectionForEpoch(scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getUnresolvedCuration throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getUnresolvedSelection(scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getUserProjectionsForEpoch throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getUserProjectionsForEpoch(scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getPoolComponentsForEpoch throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getPoolComponentsForEpoch(scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getStatementForEpoch throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getStatementForEpoch(scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("getSelectionCandidates throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.getSelectionCandidates(TEST_NODE_ID, scopeTestEpochId)
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("updateSelectionUserId throws EpochNotFoundError for cross-scope epochId", async () => {
      await expect(
        otherScopeAdapter.updateSelectionUserId(
          scopeTestEpochId,
          "any-event",
          "any-user"
        )
      ).rejects.toThrow(EpochNotFoundError);
    });

    it("listEpochs returns empty for wrong scope", async () => {
      const results = await otherScopeAdapter.listEpochs(TEST_NODE_ID);
      const match = results.find((e) => e.id === scopeTestEpochId);
      expect(match).toBeUndefined();
    });

    it("same-scope adapter can access the epoch normally", async () => {
      const result = await adapter.getEpoch(scopeTestEpochId);
      expect(result).not.toBeNull();
      expect(result?.scopeId).toBe(TEST_SCOPE_ID);
    });
  });

  // ── Evaluations ───────────────────────────────────────────────

  describe("upsertDraftEvaluation + reads", () => {
    let evalEpochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(40),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      evalEpochId = epoch.id;
    });

    afterAll(async () => {
      // Transition to review then finalized to free ONE_OPEN_EPOCH slot
      await adapter.closeIngestion(
        evalEpochId,
        [],
        "test-approver-set-hash",
        "weight-sum-v0",
        "test-weight-config-hash"
      );
      await adapter.finalizeEpoch(evalEpochId, 0n);
    });

    it("upsertDraftEvaluation inserts and getEvaluation retrieves it", async () => {
      const params = makeEvaluation({ epochId: evalEpochId });
      await adapter.upsertDraftEvaluation(params);

      const result = await adapter.getEvaluation(
        evalEpochId,
        "cogni.echo.v0",
        "draft"
      );
      expect(result).not.toBeNull();
      expect(result?.evaluationRef).toBe("cogni.echo.v0");
      expect(result?.algoRef).toBe("echo-enricher-v0");
      expect(result?.inputsHash).toBe("a".repeat(64));
      expect(result?.payloadHash).toBe("b".repeat(64));
      expect(result?.payloadJson).toEqual({ test: true });
      expect(result?.status).toBe("draft");
    });

    it("upsertDraftEvaluation overwrites existing draft (same ref)", async () => {
      const newHash = "c".repeat(64);
      await adapter.upsertDraftEvaluation(
        makeEvaluation({
          epochId: evalEpochId,
          payloadHash: newHash,
          payloadJson: { updated: true },
        })
      );

      const all = await adapter.getEvaluationsForEpoch(evalEpochId, "draft");
      expect(all).toHaveLength(1);
      expect(all[0]?.payloadHash).toBe(newHash);
      expect(all[0]?.payloadJson).toEqual({ updated: true });
    });

    it("getEvaluation returns null for nonexistent ref", async () => {
      const result = await adapter.getEvaluation(
        evalEpochId,
        "cogni.nonexistent.v0"
      );
      expect(result).toBeNull();
    });
  });

  describe("closeIngestionWithEvaluations", () => {
    let closeEpochId: bigint;
    const evalRef = "cogni.echo.v0";
    const testArtifactsHash = "d".repeat(64);

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(41),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      closeEpochId = epoch.id;

      // Seed receipts + selections + user projections + pool (required for close)
      const { periodStart, periodEnd } = epochWindow(41);
      const mid = new Date((periodStart.getTime() + periodEnd.getTime()) / 2);

      await adapter.insertIngestionReceipts([
        makeIngestionReceipt({
          receiptId: `eval-close-receipt-${closeEpochId}-1`,
          nodeId: TEST_NODE_ID,
          platformUserId: "gh-user-101",
          platformLogin: "alice",
          eventTime: mid,
          retrievedAt: mid,
        }),
      ]);

      await adapter.insertSelectionDoNothing([
        makeSelectionAuto({
          nodeId: TEST_NODE_ID,
          epochId: closeEpochId,
          receiptId: `eval-close-receipt-${closeEpochId}-1`,
          userId: actor.user.id,
          included: true,
        }),
      ]);

      await adapter.insertUserProjections([
        makeUserProjection({
          nodeId: TEST_NODE_ID,
          epochId: closeEpochId,
          userId: actor.user.id,
          projectedUnits: 1000n,
          receiptCount: 1,
        }),
      ]);

      await adapter.insertPoolComponent(
        makePoolComponent({
          nodeId: TEST_NODE_ID,
          epochId: closeEpochId,
        })
      );

      // Insert a draft evaluation first (to test coexistence with locked)
      await adapter.upsertDraftEvaluation(
        makeEvaluation({ epochId: closeEpochId })
      );
    });

    it("atomic close: inserts locked evaluations + sets artifactsHash + transitions to review", async () => {
      const result = await adapter.closeIngestionWithEvaluations({
        epochId: closeEpochId,
        approvers: [],
        approverSetHash: "test-approver-set-hash",
        allocationAlgoRef: "weight-sum-v0",
        weightConfigHash: "test-weight-config-hash",
        evaluations: [
          makeEvaluation({ epochId: closeEpochId, status: "locked" }),
        ],
        artifactsHash: testArtifactsHash,
      });

      expect(result.status).toBe("review");
      expect(result.artifactsHash).toBe(testArtifactsHash);

      // Locked evaluation retrievable
      const locked = await adapter.getEvaluation(
        closeEpochId,
        evalRef,
        "locked"
      );
      expect(locked).not.toBeNull();
      expect(locked?.status).toBe("locked");

      // Draft still exists (coexistence)
      const draft = await adapter.getEvaluation(closeEpochId, evalRef, "draft");
      expect(draft).not.toBeNull();
      expect(draft?.status).toBe("draft");

      // getEvaluationsForEpoch returns both
      const all = await adapter.getEvaluationsForEpoch(closeEpochId);
      expect(all).toHaveLength(2);
      const statuses = all.map((e) => e.status).sort();
      expect(statuses).toEqual(["draft", "locked"]);
    });

    it("idempotent on already-reviewed epoch", async () => {
      const result = await adapter.closeIngestionWithEvaluations({
        epochId: closeEpochId,
        approvers: [],
        approverSetHash: "test-approver-set-hash",
        allocationAlgoRef: "weight-sum-v0",
        weightConfigHash: "test-weight-config-hash",
        evaluations: [
          makeEvaluation({ epochId: closeEpochId, status: "locked" }),
        ],
        artifactsHash: testArtifactsHash,
      });

      expect(result.status).toBe("review");
    });

    it("throws EpochNotFoundError for wrong scope", async () => {
      const wrongScopeAdapter = new DrizzleAttributionAdapter(
        db,
        OTHER_SCOPE_ID
      );
      await expect(
        wrongScopeAdapter.closeIngestionWithEvaluations({
          epochId: closeEpochId,
          approvers: [],
          approverSetHash: "test-approver-set-hash",
          allocationAlgoRef: "weight-sum-v0",
          weightConfigHash: "test-weight-config-hash",
          evaluations: [],
          artifactsHash: testArtifactsHash,
        })
      ).rejects.toThrow(EpochNotFoundError);
    });
  });

  describe("getSelectedReceiptsWithMetadata", () => {
    let metaEpochId: bigint;
    let actorMeta: TestActor;

    beforeAll(async () => {
      actorMeta = await seedTestActor(db);
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(42),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      metaEpochId = epoch.id;

      const { periodStart, periodEnd } = epochWindow(42);
      const mid = new Date((periodStart.getTime() + periodEnd.getTime()) / 2);

      await adapter.insertIngestionReceipts([
        makeIngestionReceipt({
          receiptId: `meta-receipt-${metaEpochId}-1`,
          nodeId: TEST_NODE_ID,
          platformUserId: "gh-user-301",
          platformLogin: "charlie",
          metadata: {
            body: "fixes task.0102",
            branch: "feat/foo",
            labels: ["governance"],
          },
          payloadHash: "meta-hash-1",
          eventTime: mid,
          retrievedAt: mid,
        }),
        makeIngestionReceipt({
          receiptId: `meta-receipt-${metaEpochId}-2`,
          nodeId: TEST_NODE_ID,
          platformUserId: "gh-user-302",
          platformLogin: "diana",
          metadata: { body: "no work items here" },
          payloadHash: "meta-hash-2",
          eventTime: mid,
          retrievedAt: mid,
        }),
      ]);

      // Select with resolved user IDs
      await adapter.insertSelectionDoNothing([
        makeSelectionAuto({
          nodeId: TEST_NODE_ID,
          epochId: metaEpochId,
          receiptId: `meta-receipt-${metaEpochId}-1`,
          userId: actor.user.id,
          included: true,
        }),
        makeSelectionAuto({
          nodeId: TEST_NODE_ID,
          epochId: metaEpochId,
          receiptId: `meta-receipt-${metaEpochId}-2`,
          userId: actorMeta.user.id,
          included: true,
        }),
      ]);
    });

    afterAll(async () => {
      await adapter.closeIngestion(
        metaEpochId,
        [],
        "test-approver-set-hash",
        "weight-sum-v0",
        "test-weight-config-hash"
      );
      await adapter.finalizeEpoch(metaEpochId, 0n);
    });

    it("returns metadata + payloadHash alongside selection fields", async () => {
      const results =
        await adapter.getSelectedReceiptsWithMetadata(metaEpochId);

      expect(results).toHaveLength(2);

      const first = results.find((r) => r.userId === actor.user.id);
      expect(first).toBeDefined();
      expect(first?.metadata).toEqual({
        body: "fixes task.0102",
        branch: "feat/foo",
        labels: ["governance"],
      });
      expect(first?.payloadHash).toBe("meta-hash-1");
      expect(first?.source).toBe("github");
      expect(first?.eventType).toBe("pr_merged");
      expect(first?.included).toBe(true);

      const second = results.find((r) => r.userId === actorMeta.user.id);
      expect(second).toBeDefined();
      expect(second?.metadata).toEqual({ body: "no work items here" });
      expect(second?.payloadHash).toBe("meta-hash-2");
    });
  });

  // ── Subject Overrides ──────────────────────────────────────────

  describe("review subject overrides", () => {
    let reviewEpochId: bigint;
    let finalized = false;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(90),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      // Transition to review so overrides are allowed
      await adapter.closeIngestion(
        epoch.id,
        [],
        "override-test-hash",
        "weight-sum-v0",
        "override-wch"
      );
      reviewEpochId = epoch.id;
    });

    afterAll(async () => {
      // Clean up: finalize the review epoch if not already done by a test
      if (!finalized) {
        await adapter.finalizeEpoch(reviewEpochId, 0n);
      }
    });

    it("upsertReviewSubjectOverride inserts a new override", async () => {
      const result = await adapter.upsertReviewSubjectOverride({
        nodeId: TEST_NODE_ID,
        epochId: reviewEpochId,
        subjectRef: "github:pr:test/repo:100",
        overrideUnits: 500n,
        overrideSharesJson: null,
        overrideReason: "test override",
      });

      expect(result.subjectRef).toBe("github:pr:test/repo:100");
      expect(result.overrideUnits).toBe(500n);
      expect(result.overrideSharesJson).toBeNull();
      expect(result.overrideReason).toBe("test override");
    });

    it("upsertReviewSubjectOverride updates on conflict (same epoch + subjectRef)", async () => {
      const updated = await adapter.upsertReviewSubjectOverride({
        nodeId: TEST_NODE_ID,
        epochId: reviewEpochId,
        subjectRef: "github:pr:test/repo:100",
        overrideUnits: 999n,
        overrideSharesJson: null,
        overrideReason: "updated reason",
      });

      expect(updated.overrideUnits).toBe(999n);
      expect(updated.overrideReason).toBe("updated reason");

      // Only one override should exist for this subjectRef
      const all =
        await adapter.getReviewSubjectOverridesForEpoch(reviewEpochId);
      const matching = all.filter(
        (o) => o.subjectRef === "github:pr:test/repo:100"
      );
      expect(matching).toHaveLength(1);
    });

    it("upsertReviewSubjectOverride with overrideSharesJson round-trips JSONB correctly", async () => {
      const shares = [
        {
          claimant: { kind: "user" as const, userId: "user-1" },
          sharePpm: 600_000,
        },
        {
          claimant: {
            kind: "identity" as const,
            provider: "github",
            externalId: "12345",
            providerLogin: null,
          },
          sharePpm: 400_000,
        },
      ];

      const result = await adapter.upsertReviewSubjectOverride({
        nodeId: TEST_NODE_ID,
        epochId: reviewEpochId,
        subjectRef: "github:pr:test/repo:200",
        overrideUnits: null,
        overrideSharesJson: shares,
        overrideReason: null,
      });

      expect(result.overrideSharesJson).toEqual(shares);
    });

    it("getReviewSubjectOverridesForEpoch returns overrides ordered by subjectRef", async () => {
      const all =
        await adapter.getReviewSubjectOverridesForEpoch(reviewEpochId);
      expect(all.length).toBeGreaterThanOrEqual(2);

      const refs = all.map((o) => o.subjectRef);
      const sorted = [...refs].sort();
      expect(refs).toEqual(sorted);
    });

    it("batchUpsertReviewSubjectOverrides inserts multiple atomically", async () => {
      const results = await adapter.batchUpsertReviewSubjectOverrides([
        {
          nodeId: TEST_NODE_ID,
          epochId: reviewEpochId,
          subjectRef: "github:pr:test/repo:301",
          overrideUnits: 100n,
          overrideSharesJson: null,
          overrideReason: "batch-1",
        },
        {
          nodeId: TEST_NODE_ID,
          epochId: reviewEpochId,
          subjectRef: "github:pr:test/repo:302",
          overrideUnits: 200n,
          overrideSharesJson: null,
          overrideReason: "batch-2",
        },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]?.subjectRef).toBe("github:pr:test/repo:301");
      expect(results[1]?.subjectRef).toBe("github:pr:test/repo:302");
    });

    it("deleteReviewSubjectOverride removes an override", async () => {
      await adapter.deleteReviewSubjectOverride(
        reviewEpochId,
        "github:pr:test/repo:301"
      );

      const all =
        await adapter.getReviewSubjectOverridesForEpoch(reviewEpochId);
      const deleted = all.find(
        (o) => o.subjectRef === "github:pr:test/repo:301"
      );
      expect(deleted).toBeUndefined();
    });

    it("deleteReviewSubjectOverride is a no-op for nonexistent subjectRef", async () => {
      await expect(
        adapter.deleteReviewSubjectOverride(reviewEpochId, "nonexistent:ref")
      ).resolves.not.toThrow();
    });

    it("upsertReviewSubjectOverride throws EpochNotInReviewError for open epoch", async () => {
      const openEpoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(91),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      await expect(
        adapter.upsertReviewSubjectOverride({
          nodeId: TEST_NODE_ID,
          epochId: openEpoch.id,
          subjectRef: "github:pr:test/repo:999",
          overrideUnits: 100n,
          overrideSharesJson: null,
          overrideReason: null,
        })
      ).rejects.toThrow(EpochNotInReviewError);

      // Clean up
      await adapter.closeIngestion(
        openEpoch.id,
        [],
        "cleanup",
        "weight-sum-v0",
        "cleanup-wch"
      );
      await adapter.finalizeEpoch(openEpoch.id, 0n);
    });

    it("deleteReviewSubjectOverride throws EpochNotInReviewError for finalized epoch", async () => {
      // Finalize the review epoch
      await adapter.finalizeEpoch(reviewEpochId, 0n);
      finalized = true;

      await expect(
        adapter.deleteReviewSubjectOverride(
          reviewEpochId,
          "github:pr:test/repo:100"
        )
      ).rejects.toThrow(EpochNotInReviewError);
    });
  });

  // ── Receipt Claimants ────────────────────────────────────────────
  describe("receipt claimants (upsert / lock / load)", () => {
    let claimantEpochId: bigint;

    beforeAll(async () => {
      const epoch = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(200),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      claimantEpochId = epoch.id;

      // Seed receipts + selections so epoch has data
      await adapter.insertIngestionReceipts([
        makeIngestionReceipt({
          receiptId: "claimant-r1",
          nodeId: TEST_NODE_ID,
        }),
        makeIngestionReceipt({
          receiptId: "claimant-r2",
          nodeId: TEST_NODE_ID,
        }),
      ]);
      await adapter.insertSelectionDoNothing([
        makeSelectionAuto({
          epochId: claimantEpochId,
          receiptId: "claimant-r1",
        }),
        makeSelectionAuto({
          epochId: claimantEpochId,
          receiptId: "claimant-r2",
        }),
      ]);
    });

    afterAll(async () => {
      // Clean up: close + finalize so no open epoch leaks
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      if (open) {
        await adapter.closeIngestion(
          open.id,
          [],
          "cleanup",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await adapter.finalizeEpoch(open.id, 0n);
      }
    });

    it("upsertDraftClaimants inserts a draft row", async () => {
      await adapter.upsertDraftClaimants({
        nodeId: TEST_NODE_ID,
        epochId: claimantEpochId,
        receiptId: "claimant-r1",
        resolverRef: "cogni.default-author.v0",
        algoRef: "default-author-v0",
        inputsHash: "hash-aaa",
        claimantKeys: ["user:u1"],
        createdBy: "system",
      });

      // loadLockedClaimants should return nothing (still draft)
      const locked = await adapter.loadLockedClaimants(claimantEpochId);
      expect(locked).toHaveLength(0);
    });

    it("upsertDraftClaimants overwrites on same (node, epoch, receipt) with different inputsHash", async () => {
      // Second upsert with a different inputsHash — should overwrite, not duplicate
      await adapter.upsertDraftClaimants({
        nodeId: TEST_NODE_ID,
        epochId: claimantEpochId,
        receiptId: "claimant-r1",
        resolverRef: "cogni.default-author.v0",
        algoRef: "default-author-v0",
        inputsHash: "hash-bbb", // different hash
        claimantKeys: ["user:u1-resolved"],
        createdBy: "system",
      });

      // Insert a second receipt's claimants
      await adapter.upsertDraftClaimants({
        nodeId: TEST_NODE_ID,
        epochId: claimantEpochId,
        receiptId: "claimant-r2",
        resolverRef: "cogni.default-author.v0",
        algoRef: "default-author-v0",
        inputsHash: "hash-ccc",
        claimantKeys: ["user:u2"],
        createdBy: "system",
      });
    });

    it("lockClaimantsForEpoch creates locked copies and deletes drafts", async () => {
      const count = await adapter.lockClaimantsForEpoch(claimantEpochId);
      expect(count).toBe(2); // claimant-r1 + claimant-r2

      const locked = await adapter.loadLockedClaimants(claimantEpochId);
      expect(locked).toHaveLength(2);

      const r1 = locked.find((r) => r.receiptId === "claimant-r1");
      expect(r1).toBeDefined();
      expect(r1?.status).toBe("locked");
      expect(r1?.claimantKeys).toEqual(["user:u1-resolved"]); // overwritten value
      expect(r1?.inputsHash).toBe("hash-bbb"); // overwritten hash

      const r2 = locked.find((r) => r.receiptId === "claimant-r2");
      expect(r2).toBeDefined();
      expect(r2?.status).toBe("locked");
      expect(r2?.claimantKeys).toEqual(["user:u2"]);
    });

    it("lockClaimantsForEpoch returns 0 when no drafts remain", async () => {
      const count = await adapter.lockClaimantsForEpoch(claimantEpochId);
      expect(count).toBe(0);
    });

    it("loadLockedClaimants returns only locked rows for the epoch", async () => {
      const locked = await adapter.loadLockedClaimants(claimantEpochId);
      expect(locked).toHaveLength(2);
      for (const row of locked) {
        expect(row.status).toBe("locked");
        expect(row.epochId).toBe(claimantEpochId);
        expect(row.nodeId).toBe(TEST_NODE_ID);
      }
    });
  });

  // ── Cross-epoch same-scope deduplication (bug.0243) ───────────

  describe("getSelectionCandidates cross-epoch dedup (bug.0243)", () => {
    const otherScopeAdapter = new DrizzleAttributionAdapter(db, OTHER_SCOPE_ID);
    let epoch1Id: bigint;
    let epoch2Id: bigint;
    let otherScopeEpochId: bigint;

    beforeAll(async () => {
      // Shared receipts — ingested once, global (RECEIPT_SCOPE_AGNOSTIC)
      await adapter.insertIngestionReceipts([
        makeIngestionReceipt({
          receiptId: "dedup:pr:1",
          eventTime: new Date("2026-04-01T10:00:00Z"),
          platformUserId: "u1",
        }),
        makeIngestionReceipt({
          receiptId: "dedup:pr:2",
          eventTime: new Date("2026-04-01T11:00:00Z"),
          platformUserId: "u2",
        }),
        makeIngestionReceipt({
          receiptId: "dedup:pr:3",
          eventTime: new Date("2026-04-02T10:00:00Z"),
          platformUserId: "u3",
        }),
      ]);

      // Epoch 1 (same scope) — select dedup:pr:1 and dedup:pr:2
      const e1 = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(300),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epoch1Id = e1.id;

      await adapter.insertSelectionDoNothing([
        makeSelectionAuto({
          nodeId: TEST_NODE_ID,
          epochId: epoch1Id,
          receiptId: "dedup:pr:1",
          userId: null,
          included: true,
        }),
        makeSelectionAuto({
          nodeId: TEST_NODE_ID,
          epochId: epoch1Id,
          receiptId: "dedup:pr:2",
          userId: null,
          included: true,
        }),
      ]);

      // Close + finalize epoch 1 so we can open epoch 2
      await adapter.closeIngestion(
        epoch1Id,
        [],
        "dedup-hash-1",
        "weight-sum-v0",
        "dedup-wch-1"
      );
      await adapter.finalizeEpoch(epoch1Id, 1000n);

      // Epoch 2 (same scope) — no selections yet
      const e2 = await adapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        ...epochWindow(301),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      epoch2Id = e2.id;

      // Epoch in OTHER scope — no selections yet
      const eOther = await otherScopeAdapter.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: OTHER_SCOPE_ID,
        ...epochWindow(300),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      otherScopeEpochId = eOther.id;
    });

    afterAll(async () => {
      // Cleanup: finalize open epochs to avoid leaking ONE_OPEN_EPOCH
      const open = await adapter.getOpenEpoch(TEST_NODE_ID, TEST_SCOPE_ID);
      if (open) {
        await adapter.closeIngestion(
          open.id,
          [],
          "cleanup-hash",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await adapter.finalizeEpoch(open.id, 0n);
      }
      const otherOpen = await otherScopeAdapter.getOpenEpoch(
        TEST_NODE_ID,
        OTHER_SCOPE_ID
      );
      if (otherOpen) {
        await otherScopeAdapter.closeIngestion(
          otherOpen.id,
          [],
          "cleanup-hash",
          "weight-sum-v0",
          "cleanup-wch"
        );
        await otherScopeAdapter.finalizeEpoch(otherOpen.id, 0n);
      }
    });

    it("same-scope: epoch 2 candidates exclude receipts selected in epoch 1", async () => {
      const candidates = await adapter.getSelectionCandidates(
        TEST_NODE_ID,
        epoch2Id
      );
      const candidateIds = candidates.map((c) => c.receipt.receiptId);

      // dedup:pr:1 and dedup:pr:2 were selected in epoch 1 (same scope) — must be excluded
      expect(candidateIds).not.toContain("dedup:pr:1");
      expect(candidateIds).not.toContain("dedup:pr:2");

      // dedup:pr:3 was never selected — must be included
      expect(candidateIds).toContain("dedup:pr:3");
    });

    it("cross-scope: other scope still sees all receipts (RECEIPT_SCOPE_AGNOSTIC)", async () => {
      const candidates = await otherScopeAdapter.getSelectionCandidates(
        TEST_NODE_ID,
        otherScopeEpochId
      );
      const candidateIds = candidates.map((c) => c.receipt.receiptId);

      // All three receipts should be candidates — epoch 1 selections are in a different scope
      expect(candidateIds).toContain("dedup:pr:1");
      expect(candidateIds).toContain("dedup:pr:2");
      expect(candidateIds).toContain("dedup:pr:3");
    });
  });
});
