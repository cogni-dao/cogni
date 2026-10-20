// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real PostgreSQL proof of cancellation, submission fencing and reusable-pair custody. */
import { createAppDbClient } from "@cogni/db-client";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import type { AkashPreviewAdmissionInput } from "@/ports";
import { akashPreviewAdmissions, akashTxAllocations } from "@/shared/db/schema";

const WALLET = `akash-console:akash1${"p".repeat(38)}`;
const OTHER_WALLET = `akash-console:akash1${"q".repeat(38)}`;
const NODE = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";
const ID = "55616668-2668-4be8-a020-11d24fd61561";
const GEN = "2616bc5c-5c0f-4cbf-ae01-82c376897448";
const identity = {
  nodeId: NODE,
  compositeUid: "preview-fixture",
  compositeGeneration: 1,
};
const admission = (n = 1): AkashPreviewAdmissionInput => ({
  deploymentId: ID.slice(0, -1) + n,
  nodeId: NODE,
  environment: "candidate-a",
  requestKey: `preview-${n}`,
  payloadHash: "a".repeat(64),
  sourceSha: "b".repeat(40),
  artifactRef: `ghcr.io/cogni-test-org/fixture@sha256:${"c".repeat(64)}`,
  bundleRef: `ghcr.io/cogni-test-org/bundle@sha256:${"d".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("preview cancellation (real PostgreSQL)", () => {
  const seed = getSeedDb();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("component DATABASE_URL missing");
  // Independent role-enforced connections: process-local serialization cannot make these pass.
  const dbA = createAppDbClient(url, {
    max: 1,
    applicationName: "preview_race_a",
  });
  const dbB = createAppDbClient(url, {
    max: 1,
    applicationName: "preview_race_b",
  });
  const a = new DrizzleAkashTxAllocationLedger(async () => dbA, WALLET);
  const b = new DrizzleAkashTxAllocationLedger(async () => dbB, WALLET);
  const claim = (ledger = a, cogniKey = "base", deploymentId = ID) =>
    ledger.claim({
      cogniKey,
      identity,
      environment: "candidate-a",
      workload: "fixture",
      previewDeploymentId: deploymentId,
    });
  const bind = async (input = admission()) => {
    const row = await a.preview.admit(input);
    await a.preview.withUnallocatedStateReservation(
      row.deploymentId,
      row.stateSlot,
      async () => ({ resetGeneration: GEN })
    );
    await a.preview.bindResolvedSpec({
      deploymentId: row.deploymentId,
      sourceSha: row.sourceSha,
      artifactRef: row.artifactRef,
      sdlHash: "e".repeat(64),
    });
    return row;
  };
  const submit = (ledger = a, phase: "deployment" | "lease" = "deployment") =>
    ledger.preview.beforeProviderTransaction({
      deploymentId: ID,
      cogniKey: "base",
      phase,
    });
  beforeEach(async () => {
    for (const wallet of [WALLET, OTHER_WALLET]) {
      await seed
        .delete(akashTxAllocations)
        .where(eq(akashTxAllocations.walletScope, wallet));
      await seed
        .delete(akashPreviewAdmissions)
        .where(eq(akashPreviewAdmissions.walletScope, wallet));
    }
  });
  afterAll(async () => {
    await dbA.$client.end();
    await dbB.$client.end();
  });

  it("admits two distinct slots concurrently; third stays rejected", async () => {
    const rows = await Promise.all([
      a.preview.admit(admission(1)),
      b.preview.admit(admission(2)),
    ]);
    expect(rows.map((r) => r.stateSlot).sort()).toEqual([0, 1]);
    await expect(a.preview.admit(admission(3))).rejects.toMatchObject({
      reason: "capacity",
    });
  });
  it("cancels before admission insertion and forbids a late request or recovery key", async () => {
    const input = admission();
    expect(await a.preview.cancel(input)).toMatchObject({
      revokedAt: expect.any(Date),
      closureObservedAt: expect.any(Date),
    });
    expect(await b.preview.admit(input)).toMatchObject({
      closureObservedAt: expect.any(Date),
    });
    await expect(claim(b)).rejects.toMatchObject({ reason: "terminal" });
    await expect(claim(b, "base:recover:1")).rejects.toMatchObject({
      reason: "terminal",
    });
  });
  it("serializes concurrent absent cancel and admit into a terminal request", async () => {
    const input = admission();
    await Promise.all([a.preview.admit(input), b.preview.cancel(input)]);
    expect(await a.preview.read(ID)).toMatchObject({
      revokedAt: expect.any(Date),
    });
    await expect(claim()).rejects.toMatchObject({ reason: "terminal" });
  });
  it("refuses same deployment UUID from another wallet", async () => {
    const input = admission();
    await a.preview.admit(input);
    const foreign = new DrizzleAkashTxAllocationLedger(
      async () => dbB,
      OTHER_WALLET
    );
    await expect(foreign.preview.admit(input)).rejects.toMatchObject({
      reason: "conflict",
    });
  });
  it("cancel after admission but before allocation insert fences every claim", async () => {
    await bind();
    await a.preview.revoke(ID);
    await expect(claim(b)).rejects.toMatchObject({ reason: "terminal" });
    await expect(claim(b, "base:recover:1")).rejects.toMatchObject({
      reason: "terminal",
    });
    await expect(
      a.preview.finishRetirement({
        deploymentId: ID,
        observedClosedReceiptIds: [],
      })
    ).resolves.toMatchObject({ closureObservedAt: expect.any(Date) });
  });
  it("a bound receipt cannot downgrade identity on retry, prepare or mutation", async () => {
    await bind();
    await claim();
    await expect(
      b.claim({
        cogniKey: "base",
        identity,
        environment: "candidate-a",
        workload: "fixture",
      })
    ).rejects.toMatchObject({ reason: "conflict" });
    await expect(
      b.prepare({ cogniKey: "base", allocationCursor: "1" })
    ).rejects.toThrow();
    await a.preview.revoke(ID);
    await expect(
      b.bindIdentity({ cogniKey: "base", identity, environment: "candidate-a" })
    ).rejects.toMatchObject({ reason: "terminal" });
  });
  it("cancel after prepare rejects the unpaid submission hook", async () => {
    await bind();
    await claim();
    await a.prepare({
      cogniKey: "base",
      allocationCursor: "1",
      previewDeploymentId: ID,
    });
    await b.preview.revoke(ID);
    await expect(submit()).rejects.toMatchObject({ reason: "terminal" });
    expect(
      (await a.read({ cogniKey: "base" }))?.previewSubmittedAt
    ).toBeUndefined();
  });
  it("two same-key creators receive exactly one deployment submission grant", async () => {
    await bind();
    await Promise.all([claim(a), claim(b)]);
    await a.prepare({
      cogniKey: "base",
      allocationCursor: "1",
      previewDeploymentId: ID,
    });
    const outcomes = await Promise.allSettled([submit(a), submit(b)]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("records a late handle after cancellation; only positive closure frees custody even after creator crash", async () => {
    await bind();
    await claim();
    await a.prepare({
      cogniKey: "base",
      allocationCursor: "1",
      previewDeploymentId: ID,
    });
    await submit();
    await b.preview.revoke(ID);
    await b.recordAllocation({ cogniKey: "base", externalName: "123" });
    await expect(submit(a, "lease")).rejects.toMatchObject({
      reason: "terminal",
    });
    await expect(
      a.preview.finishRetirement({
        deploymentId: ID,
        observedClosedReceiptIds: [],
      })
    ).rejects.toMatchObject({ reason: "unresolved" });
    await a.markReleased({ cogniKey: "base" });
    const receipt = await a.read({ cogniKey: "base" });
    if (!receipt) throw new Error("missing fixture");
    expect(receipt.previewDispatchFinishedAt).toBeUndefined();
    await expect(
      b.preview.finishRetirement({
        deploymentId: ID,
        observedClosedReceiptIds: [receipt.receiptId],
      })
    ).resolves.toMatchObject({ closureObservedAt: expect.any(Date) });
  });
  it("dispatch finally does not settle a submitted/no-handle unknown outcome", async () => {
    await bind();
    await claim();
    await submit();
    await b.preview.revoke(ID);
    await a.preview.finishDispatch({ deploymentId: ID, cogniKey: "base" });
    await expect(
      a.preview.finishRetirement({
        deploymentId: ID,
        observedClosedReceiptIds: [],
      })
    ).rejects.toMatchObject({ reason: "unresolved" });
    expect((await a.preview.read(ID))?.closureObservedAt).toBeUndefined();
  });
  it("holds create suspended throughout pair reset and binds generation before granting submission", async () => {
    const row = await a.preview.admit(admission());
    await claim();
    await a.preview.bindResolvedSpec({
      deploymentId: ID,
      sourceSha: row.sourceSha,
      artifactRef: row.artifactRef,
      sdlHash: "e".repeat(64),
    });
    await expect(submit()).rejects.toMatchObject({ reason: "unresolved" });
    const entered = deferred(),
      release = deferred();
    const resetting = a.preview.withUnallocatedStateReservation(
      ID,
      row.stateSlot,
      async () => {
        entered.resolve();
        await release.promise;
        return { resetGeneration: GEN };
      }
    );
    await entered.promise;
    const pending = submit(b);
    release.resolve();
    await resetting;
    await pending;
    expect(await a.preview.read(ID)).toMatchObject({ resetGeneration: GEN });
    await expect(
      a.preview.withUnallocatedStateReservation(
        ID,
        row.stateSlot,
        async () => ({ resetGeneration: GEN })
      )
    ).rejects.toMatchObject({ reason: "conflict" });
  });
  it("uses fresh database clock after waiting for the admission lock", async () => {
    await bind();
    const locked = deferred(),
      release = deferred();
    let observeBlock = async () => false;
    const holder = dbA.transaction(async (tx) => {
      observeBlock = async () => {
        const rows = await tx.execute(
          sql`select 1 from pg_stat_activity where application_name='preview_race_b' and cardinality(pg_blocking_pids(pid)) > 0`
        );
        return rows.length > 0;
      };
      await tx
        .select()
        .from(akashPreviewAdmissions)
        .where(eq(akashPreviewAdmissions.deploymentId, ID))
        .for("update");
      locked.resolve();
      await release.promise;
      await tx
        .update(akashPreviewAdmissions)
        .set({
          createdAt: sql`clock_timestamp()-interval '1 hour'`,
          expiresAt: sql`clock_timestamp()`,
        })
        .where(eq(akashPreviewAdmissions.deploymentId, ID));
    });
    await locked.promise;
    const pending = b.preview.assertActive({
      deploymentId: ID,
      nodeId: NODE,
      environment: "candidate-a",
    });
    // Observe the independent transaction through the SAME app role (service cannot see wait details).
    try {
      for (let i = 0; i < 200; i++) {
        if (await observeBlock()) break;
        if (i === 199) throw new Error("fixture never waited on lock");
      }
    } finally {
      release.resolve();
    }
    await holder;
    await expect(pending).rejects.toMatchObject({ reason: "expired" });
  });
  it("generic fail cannot reopen a submitted preview or clear wallet custody", async () => {
    await bind();
    await claim();
    await submit();
    await a.fail({ cogniKey: "base", failureCode: "empty_scan" });
    expect(await claim(b)).toMatchObject({
      state: "owned",
      record: { state: "preparing", previewSubmittedAt: expect.any(Date) },
    });
    await expect(submit(b)).rejects.toMatchObject({ reason: "unresolved" });
  });
  it("cannot allocate a second recovery receipt while this preview still owns a handle", async () => {
    await bind();
    await claim();
    await submit();
    await a.recordAllocation({ cogniKey: "base", externalName: "123" });
    await expect(claim(b, "base:recover:1")).rejects.toMatchObject({
      reason: "unresolved",
    });
    await a.markReleased({ cogniKey: "base" });
    await expect(claim(b, "base:recover:1")).rejects.toMatchObject({
      reason: "unresolved",
    });
  });
  it("serializes migration Job ensure before retirement and forbids late writers", async () => {
    const row = await bind();
    const entered = deferred(),
      release = deferred();
    const events: string[] = [];
    const ensuring = a.preview.withActiveState(
      { deploymentId: ID, stateSlot: row.stateSlot, resetGeneration: GEN },
      async () => {
        entered.resolve();
        await release.promise;
        events.push("job_created");
      }
    );
    await entered.promise;
    const retiring = b.preview.revoke(ID).then(() => {
      events.push("revoked");
    });
    try {
      for (let i = 0; i < 200; i++) {
        const rows = await seed.execute(
          sql`select 1 from pg_stat_activity where application_name='preview_race_b' and cardinality(pg_blocking_pids(pid)) > 0`
        );
        if (rows.length) break;
        if (i === 199)
          throw new Error("revoke did not wait for migration fence");
      }
    } finally {
      release.resolve();
    }
    await Promise.all([ensuring, retiring]);
    expect(events).toEqual(["job_created", "revoked"]);
    await expect(
      b.preview.withActiveState(
        { deploymentId: ID, stateSlot: row.stateSlot, resetGeneration: GEN },
        async () => {
          events.push("late_job");
        }
      )
    ).rejects.toMatchObject({ reason: "terminal" });
    expect(events).not.toContain("late_job");
  });
  it("binds private resolved SDL once without replacing the public request hash", async () => {
    const row = await a.preview.admit(admission());
    const base = {
      deploymentId: ID,
      sourceSha: row.sourceSha,
      artifactRef: row.artifactRef,
    };
    const results = await Promise.allSettled([
      a.preview.bindResolvedSpec({ ...base, sdlHash: "1".repeat(64) }),
      b.preview.bindResolvedSpec({ ...base, sdlHash: "2".repeat(64) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await a.preview.read(ID)).toMatchObject({
      payloadHash: row.payloadHash,
      resolvedSdlHash: expect.any(String),
    });
    await expect(
      b.preview.bindResolvedSpec({
        ...base,
        artifactRef: "mutable:latest",
        sdlHash: "3".repeat(64),
      })
    ).rejects.toMatchObject({ reason: "conflict" });
  });
  it("a prepared generation cannot be reused by another admission after closure", async () => {
    const first = await bind();
    await a.preview.revoke(first.deploymentId);
    await a.preview.finishRetirement({
      deploymentId: first.deploymentId,
      observedClosedReceiptIds: [],
    });
    const second = await b.preview.admit(admission(2));
    await expect(
      b.preview.withUnallocatedStateReservation(
        second.deploymentId,
        second.stateSlot,
        async () => ({ resetGeneration: GEN })
      )
    ).rejects.toBeDefined();
    expect(
      (await b.preview.read(second.deploymentId))?.resetGeneration
    ).toBeUndefined();
    await expect(
      b.preview.withUnallocatedStateReservation(
        second.deploymentId,
        second.stateSlot,
        async () => ({
          resetGeneration: "894d3a9d-465d-48a8-92fd-47373d8e53fe",
        })
      )
    ).resolves.toMatchObject({
      resetGeneration: "894d3a9d-465d-48a8-92fd-47373d8e53fe",
    });
  });
  it("cancel racing admission tolerates the absolute deadline's benign clock difference", async () => {
    const input = admission();
    await a.preview.admit(input);
    await b.preview.cancel({
      ...input,
      expiresAt: new Date(input.expiresAt.getTime() + 1),
    });
    await expect(claim()).rejects.toMatchObject({ reason: "terminal" });
  });
  it("short-TTL admission races default-TTL cancel without losing terminal intent", async () => {
    const input = admission(),
      cancel = {
        ...input,
        payloadHash: "9".repeat(64),
        expiresAt: new Date(input.expiresAt.getTime() + 60_000),
      };
    const results = await Promise.allSettled([
      a.preview.admit(input),
      b.preview.cancel(cancel),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    expect((await a.preview.read(input.deploymentId))?.revokedAt).toBeDefined();
    await expect(claim()).rejects.toMatchObject({ reason: "terminal" });
  });
  it("preserves ordinary failed/no-handle retry behavior", async () => {
    const input = {
      cogniKey: "ordinary",
      identity,
      environment: "candidate-a",
      workload: "fixture",
    };
    expect(await a.claim(input)).toMatchObject({ state: "claimed" });
    await a.fail({ cogniKey: "ordinary", failureCode: "fixture" });
    expect(await b.claim(input)).toMatchObject({ state: "claimed" });
  });
});
