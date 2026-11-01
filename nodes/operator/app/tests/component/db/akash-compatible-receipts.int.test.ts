// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/akash-compatible-receipts.int`
 * Purpose: Falsify stale-callback and mixed-schema custody through the real ledger.
 * Scope: Ephemeral PostgreSQL only; no native or paid IO.
 * Invariants: Original versions, exact no-ops and preparing age survive every writer.
 * Side-effects: IO (test Postgres)
 * Links: subtask.5033; paid-admission R3 seq4.
 * @internal
 */
import { createAppDbClient, type Database } from "@cogni/db-client";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECEIPT_CONTEXT,
  RECEIPT_GUARD_BODY,
  receiptTransaction,
} from "@/adapters/server/compute/akash-receipt-transaction";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { DrizzleDatabaseCellBindingStore } from "@/adapters/server/compute/database-cell-binding-store.adapter";
import { akashTxAllocations } from "@/shared/db/schema";

const WALLET = "akash-console:akash1testwalletaddressforcomponenttests0000";
const identity = {
  nodeId: "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60",
  compositeUid: "compatible-receipts",
  compositeGeneration: 3,
};
describe("compatible receipts: real PostgreSQL", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAkashTxAllocationLedger(async () => db, WALLET);
  const app = createAppDbClient(process.env.DATABASE_URL ?? "", {
    max: 1,
    applicationName: "compatible-receipts-test",
  });
  const ddl = createAppDbClient(process.env.DATABASE_URL ?? "", {
    max: 1,
    applicationName: "compatible-receipts-ddl-test",
  });
  const guardedLedger = new DrizzleAkashTxAllocationLedger(
    async () => app,
    WALLET
  );
  type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
  const installGuard = async (connection?: Tx) => {
    const install = async (tx: Tx) => {
      await tx.execute(
        sql`ALTER TABLE public.akash_tx_allocations ADD CONSTRAINT akash_test_native_closed_shape CHECK (native_closed_verified IS NULL OR (native_closed_verified IS TRUE AND nullif(external_name, '') IS NOT NULL AND state IN ('allocated', 'released')))`
      );
      await tx.execute(
        sql`ALTER TABLE public.akash_tx_allocations ADD CONSTRAINT akash_test_no_effect_shape CHECK (allocation_no_effect_verified IS NULL OR (allocation_no_effect_verified IS TRUE AND state IN ('preparing', 'failed') AND allocation_cursor IS NULL AND external_name IS NULL) OR (allocation_no_effect_verified IS FALSE AND ((state IN ('preparing', 'failed') AND allocation_cursor IS NOT NULL AND external_name IS NULL) OR (state IN ('allocated', 'released') AND nullif(external_name, '') IS NOT NULL))))`
      );
      await tx.execute(
        sql.raw(
          `CREATE FUNCTION public.akash_receipt_writer_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $guard$${RECEIPT_GUARD_BODY}$guard$`
        )
      );
      await tx.execute(
        sql`CREATE TRIGGER akash_receipt_writer_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.akash_tx_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.akash_receipt_writer_guard_fn()`
      );
      await tx.execute(
        sql`ALTER TABLE public.akash_tx_allocations ENABLE ALWAYS TRIGGER akash_receipt_writer_guard`
      );
    };
    if (connection) await install(connection);
    else await app.transaction(install);
  };

  afterEach(async () => {
    await app.execute(
      sql`DROP TRIGGER IF EXISTS akash_receipt_writer_guard ON public.akash_tx_allocations`
    );
    await app.execute(
      sql`DROP FUNCTION IF EXISTS public.akash_receipt_writer_guard_fn()`
    );
    await app.execute(
      sql`ALTER TABLE public.akash_tx_allocations DROP CONSTRAINT IF EXISTS akash_test_native_closed_shape, DROP CONSTRAINT IF EXISTS akash_test_no_effect_shape`
    );
    await app.execute(sql`reset cogni.receipt_writer`);
  });
  afterAll(async () => {
    await app.$client.end();
    await ddl.$client.end();
  });
  const guardedClaim = () =>
    guardedLedger.claim({
      cogniKey: "xcw:candidate-a:fixture:4",
      workload: "fixture",
      environment: "candidate-a",
      identity,
    });
  const coverage = () => ({
    owner: WALLET.slice("akash-console:".length),
    height: "30000000",
    observedAt: new Date().toISOString(),
    targets: [],
  });
  const claim = () =>
    ledger.claim({
      cogniKey: "compatible",
      workload: "fixture",
      environment: "candidate-a",
      identity,
    });
  beforeEach(async () => {
    await db
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });

  const waitForRelationWait = async (tx: Tx) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      // Backend membership is cached within this DDL transaction. Clear it in a
      // separate statement so a newly opened app connection appears in the poll.
      await tx.execute(sql`select pg_stat_clear_snapshot()`);
      const [row] = await tx.execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity as activity
          join pg_locks as lock on lock.pid = activity.pid
          where activity.application_name = 'compatible-receipts-test'
            and activity.datname = current_database()
            and lock.database = (select oid from pg_database where datname = current_database())
            and lock.locktype = 'relation'
            and lock.relation = 'public.akash_tx_allocations'::regclass
            and lock.mode = 'RowExclusiveLock'
            and not lock.granted
            and pg_backend_pid() = any(pg_blocking_pids(activity.pid))
        ) as waiting`);
      if (row?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("receipt operation never waited on real relation lock");
  };

  it.each([
    "install",
    "remove",
  ] as const)("selects committed stage after %s DDL lock contention", async (stage) => {
    if (stage === "remove") await installGuard();
    let operation!: Promise<
      { value: boolean; error?: never } | { value?: never; error: unknown }
    >;
    try {
      await ddl.transaction(async (tx) => {
        if (stage === "install") await installGuard(tx);
        else
          await tx.execute(
            sql`drop trigger akash_receipt_writer_guard on public.akash_tx_allocations`
          );
        operation = receiptTransaction(
          app,
          async (locked, guarded) => {
            const [context] = await locked.execute<{ writer: string }>(
              sql`select current_setting('cogni.receipt_writer', true) as writer`
            );
            expect(context?.writer).toBe(guarded ? RECEIPT_CONTEXT : "");
            await locked.insert(akashTxAllocations).values({
              walletScope: WALLET,
              cogniKey: "ddl-wait",
              nodeId: identity.nodeId,
              compositeUid: identity.compositeUid,
              compositeGeneration: 3,
              workload: "fixture",
              environment: "candidate-a",
              state: "preparing",
              allocationNoEffectVerified: guarded ? true : null,
            });
            return guarded;
          },
          Date.now() + 5000
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        // Observe the actual PostgreSQL lock wait, not just a JavaScript pause.
        await waitForRelationWait(tx);
      });
    } finally {
      // The DDL transaction has committed or rolled back before draining the writer.
      await operation;
    }
    const result = await operation;
    if ("error" in result) throw result.error;
    expect(result.value).toBe(stage === "install");
    expect(
      (await guardedLedger.read({ cogniKey: "ddl-wait" }))
        ?.allocationNoEffectVerified
    ).toBe(stage === "install" ? true : null);
  });

  it.each([
    false,
    true,
  ])("preserves immutable workload and atomic retained reclaim, guarded=%s", async (guarded) => {
    if (guarded) await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("claim missing");
    const failed = await guardedLedger.fail({
      cogniKey: first.record.cogniKey,
      failureCode: "unused",
      expected: first.record,
    });
    const conflict = await guardedLedger.claim({
      cogniKey: first.record.cogniKey,
      workload: "foreign-workload",
      environment: "candidate-a",
      identity,
      retentionPolicy: "retain",
    });
    expect(conflict.state).toBe("settled");
    expect(
      await guardedLedger.read({ cogniKey: first.record.cogniKey })
    ).toEqual(failed);
    const reclaimed = await guardedLedger.claim({
      cogniKey: first.record.cogniKey,
      workload: "fixture",
      environment: "candidate-a",
      identity: { ...identity, compositeGeneration: 4 },
      retentionPolicy: "retain",
    });
    expect(reclaimed.state).toBe("claimed");
    if (reclaimed.state !== "claimed") throw new Error("reclaim missing");
    expect(reclaimed.record).toMatchObject({
      state: "preparing",
      workload: "fixture",
      retentionPolicy: "retain",
      identity: { compositeGeneration: 4 },
      allocationNoEffectVerified: guarded ? true : null,
    });
    expect(reclaimed.record.custody).not.toEqual(failed.custody);
  });

  it("bounds a queued pool admission and refuses all late application SQL", async () => {
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("claim missing");
    const connection = await app.$client.reserve();
    let ran = false;
    const started = Date.now();
    try {
      await expect(
        receiptTransaction(
          app,
          async () => {
            ran = true;
          },
          Date.now() + 100
        )
      ).rejects.toThrow(/deadline/);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      connection.release();
    }
    // This queues behind the expired BEGIN and its rollback on the same one-slot pool.
    await app.execute(sql`select 1`);
    expect(ran).toBe(false);
    expect(
      await guardedLedger.read({ cogniKey: first.record.cogniKey })
    ).toEqual(first.record);
  });

  it("times out a real relation wait without late fail or scheduler writes", async () => {
    await db.insert(akashTxAllocations).values({
      walletScope: WALLET,
      cogniKey: "scheduled",
      nodeId: identity.nodeId,
      compositeUid: "bound-old",
      compositeGeneration: 1,
      workload: "fixture",
      environment: "candidate-a",
      state: "allocated",
      externalName: "9000",
    });
    await installGuard();
    const scheduled = await guardedLedger.read({ cogniKey: "scheduled" });
    if (!scheduled) throw new Error("scheduler fixture missing");
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("claim missing");
    await ddl.transaction(async (tx) => {
      await tx.execute(
        sql`lock table public.akash_tx_allocations in access exclusive mode`
      );
      await expect(
        guardedLedger.fail({
          cogniKey: first.record.cogniKey,
          failureCode: "late",
          expected: first.record,
          deadlineAt: Date.now() + 100,
        })
      ).rejects.toThrow();
      await expect(
        guardedLedger.listStalePreparing({
          olderThanMs: 0,
          limit: 20,
          deadlineAt: Date.now() + 100,
        })
      ).rejects.toThrow();
      await expect(
        guardedLedger.listClosureCandidates(Date.now() + 100)
      ).rejects.toThrow();
      await expect(
        guardedLedger.startClosureRead(scheduled, Date.now() + 100)
      ).rejects.toThrow();
    });
    expect(
      await guardedLedger.read({ cogniKey: first.record.cogniKey })
    ).toEqual(first.record);
    expect(await guardedLedger.read({ cogniKey: "scheduled" })).toEqual(
      scheduled
    );
  });

  it("returns lossless versions and refuses the original claim after prepare", async () => {
    const first = await claim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    expect(first.record.custody?.updatedAt).toMatch(/\.\d{6}/);
    expect(first.record.allocationNoEffectVerified).toBeNull();
    const prepared = await ledger.prepare({
      cogniKey: "compatible",
      allocationCursor: "7000",
      expected: first.record,
    });
    expect(prepared?.custody?.updatedAt).not.toBe(
      first.record.custody?.updatedAt
    );
    await expect(
      ledger.fail({
        cogniKey: "compatible",
        failureCode: "late",
        expected: first.record,
      })
    ).rejects.toThrow(/custody/);
    expect((await ledger.read({ cogniKey: "compatible" }))?.state).toBe(
      "preparing"
    );
  });

  it("does not refresh preparing age for retain or generation traffic", async () => {
    const first = await claim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const bound = await ledger.bindIdentity({
      cogniKey: "compatible",
      environment: "candidate-a",
      identity: { ...identity, compositeGeneration: 4 },
      retentionPolicy: "retain",
    });
    expect(bound.state).toBe("held");
    const again = await ledger.read({ cogniKey: "compatible" });
    expect(again?.custody).toEqual(first.record.custody);
    expect(again?.retentionPolicy).toBeUndefined();
  });

  it("validates conflicting handles before recognizing an exact no-op", async () => {
    const first = await claim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const allocated = await ledger.recordAllocation({
      cogniKey: "compatible",
      externalName: "7001",
      expected: first.record,
    });
    if (!allocated) throw new Error("allocation successor missing");
    const same = await ledger.recordAllocation({
      cogniKey: "compatible",
      externalName: "7001",
      expected: allocated,
    });
    expect(same?.custody).toEqual(allocated.custody);
    await expect(
      ledger.recordAllocation({
        cogniKey: "compatible",
        externalName: "7002",
        expected: allocated,
      })
    ).rejects.toThrow(/handle/);
  });

  it("rejects ABA even if state, cursor and handle are restored", async () => {
    const first = await claim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    await db
      .update(akashTxAllocations)
      .set({ updatedAt: sql`updated_at + interval '1 microsecond'` })
      .where(eq(akashTxAllocations.id, first.record.receiptId));
    await expect(
      ledger.prepare({
        cogniKey: "compatible",
        allocationCursor: "7000",
        expected: first.record,
      })
    ).rejects.toThrow(/custody/);
  });
  it("refuses an operation paused across committed guard DDL without manufacturing provenance", async () => {
    const old = await guardedClaim();
    if (old.state !== "claimed") throw new Error("fixture claim failed");
    await installGuard();
    await expect(
      guardedLedger.prepare({
        cogniKey: old.record.cogniKey,
        allocationCursor: "8000",
        expected: old.record,
        coverage: coverage(),
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow(/unused wallet slot/);
    expect(
      (await ledger.read({ cogniKey: old.record.cogniKey }))
        ?.allocationNoEffectVerified
    ).toBeNull();
  });

  it("refuses a pre-stage prepared continuation after committed guard DDL", async () => {
    const old = await guardedClaim();
    if (old.state !== "claimed") throw new Error("fixture claim failed");
    const prepared = await guardedLedger.prepare({
      cogniKey: old.record.cogniKey,
      allocationCursor: "8000",
      expected: old.record,
    });
    await installGuard();
    await expect(
      guardedLedger.recordAllocation({
        cogniKey: prepared.cogniKey,
        externalName: "8001",
        expected: prepared,
      })
    ).rejects.toThrow(/post-barrier callback/);
    expect(
      await guardedLedger.read({ cogniKey: prepared.cogniKey })
    ).toMatchObject({
      state: "preparing",
      allocationNoEffectVerified: null,
      allocationCursor: "8000",
    });
  });

  it("qualifies all current writer seams without losing FALSE or rewriting an exact no-op", async () => {
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    expect(first.record.allocationNoEffectVerified).toBe(true);
    const prepared = await guardedLedger.prepare({
      cogniKey: first.record.cogniKey,
      allocationCursor: "8000",
      expected: first.record,
      coverage: coverage(),
      deadlineAt: Date.now() + 30_000,
    });
    expect(prepared.allocationNoEffectVerified).toBe(false);
    await expect(
      guardedLedger.adoptAllocation({
        cogniKey: prepared.cogniKey,
        externalName: "7999",
        expected: prepared,
      })
    ).rejects.toThrow(/late native CREATE/);
    const allocated = await guardedLedger.recordAllocation({
      cogniKey: prepared.cogniKey,
      externalName: "8001",
      providerAccount: "akash1provider",
      expected: prepared,
    });
    const final = await guardedLedger.recordAllocation({
      cogniKey: allocated.cogniKey,
      externalName: "8001",
      providerAccount: "akash1provider",
      expected: allocated,
    });
    expect(final.custody).toEqual(allocated.custody);
    const hashed = await guardedLedger.recordAppliedSdlHash({
      cogniKey: final.cogniKey,
      sdlHash: "a".repeat(64),
      expected: final,
    });
    const store = new DrizzleDatabaseCellBindingStore(async () => app, WALLET);
    await store.save(hashed, [], []);
    const bound = await guardedLedger.read({ cogniKey: hashed.cogniKey });
    if (!bound) throw new Error("binding missing");
    await store.save(bound, [], []);
    expect(
      (await guardedLedger.read({ cogniKey: bound.cogniKey }))?.custody
    ).toEqual(bound.custody);
    const released = await guardedLedger.markReleased({
      cogniKey: bound.cogniKey,
      expected: bound,
    });
    const started = await guardedLedger.startClosureRead(
      released,
      Date.now() + 30_000
    );
    const certified = await guardedLedger.certifyNativeClosed({
      expected: started,
      owner: coverage().owner,
      dseq: "8001",
      closed: true,
      deadlineAt: Date.now() + 30_000,
    });
    expect(certified).toMatchObject({
      state: "released",
      allocationNoEffectVerified: false,
      nativeClosedVerified: true,
      externalName: "8001",
    });
    expect(await guardedLedger.listClosureCandidates()).toEqual([]);
    const again = await guardedLedger.certifyNativeClosed({
      expected: certified,
      owner: coverage().owner,
      dseq: "8001",
      closed: true,
      deadlineAt: Date.now() + 30_000,
    });
    expect(again.custody).toEqual(certified.custody);
  });

  it("refuses old SQL target lists even for COALESCE no-ops and zero matched rows", async () => {
    const first = await claim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    await ledger.recordAllocation({
      cogniKey: "compatible",
      externalName: "8001",
      expected: first.record,
    });
    await installGuard();
    await expect(
      app.execute(
        sql`update public.akash_tx_allocations set state='allocated', external_name=coalesce(external_name, '8002') where cogni_key='compatible' and wallet_scope=${WALLET} returning id`
      )
    ).rejects.toMatchObject({
      cause: { code: "55000", message: "incompatible receipt writer" },
    });
    await expect(
      app.execute(
        sql`update public.akash_tx_allocations set state='allocated', external_name=coalesce(external_name, '8002') where false returning id`
      )
    ).rejects.toMatchObject({
      cause: { code: "55000", message: "incompatible receipt writer" },
    });
    await expect(
      app.execute(sql`delete from public.akash_tx_allocations where false`)
    ).rejects.toThrow();
    await expect(
      app.execute(sql`truncate public.akash_tx_allocations`)
    ).rejects.toThrow();
  });

  it("holds FALSE and NULL custody after empty recovery, yet unused TRUE can fail and reclaim", async () => {
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const failed = await guardedLedger.fail({
      cogniKey: first.record.cogniKey,
      failureCode: "unused",
      expected: first.record,
    });
    expect(failed.allocationNoEffectVerified).toBe(true);
    const reclaimed = await guardedClaim();
    if (reclaimed.state !== "claimed")
      throw new Error("fixture reclaim failed");
    const prepared = await guardedLedger.prepare({
      cogniKey: reclaimed.record.cogniKey,
      allocationCursor: "8000",
      expected: reclaimed.record,
      coverage: coverage(),
      deadlineAt: Date.now() + 30_000,
    });
    await expect(
      guardedLedger.fail({
        cogniKey: prepared.cogniKey,
        failureCode: "empty_scan",
        expected: prepared,
      })
    ).rejects.toThrow(/custody/);
    await expect(
      guardedLedger.prepare({
        cogniKey: reclaimed.record.cogniKey,
        allocationCursor: "8000",
        expected: reclaimed.record,
        coverage: coverage(),
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow(/custody/);
    expect((await guardedClaim()).state).toBe("owned");
  });

  it("clears transaction context on success, failure and savepoint rollback in a reused native app pool", async () => {
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const [role] = await app.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname=current_user`
    );
    expect(role?.rolbypassrls).toBe(false);
    const context = async () =>
      (
        await app.execute<{ writer: string | null }>(
          sql`select current_setting('cogni.receipt_writer', true) as writer`
        )
      )[0]?.writer;
    expect(await context()).toBe("");
    await expect(
      guardedLedger.prepare({
        cogniKey: first.record.cogniKey,
        allocationCursor: "8000",
        expected: first.record,
      })
    ).rejects.toThrow();
    expect(await context()).toBe("");
    await app.transaction(async (tx) => {
      await tx.execute(sql`savepoint receipt_test`);
      await tx.execute(
        sql`select set_config('cogni.receipt_writer', ${RECEIPT_CONTEXT}, true)`
      );
      await tx.execute(sql`rollback to savepoint receipt_test`);
      const [value] = await tx.execute<{ writer: string }>(
        sql`select current_setting('cogni.receipt_writer', true) as writer`
      );
      expect(value?.writer).toBe("");
    });
    await app.execute(
      sql`select set_config('cogni.receipt_writer', ${RECEIPT_CONTEXT}, false)`
    );
    await expect(guardedClaim()).rejects.toThrow(/unsafe receipt connection/);
  });

  it("refuses unknown native function bytes rather than guessing a schema epoch", async () => {
    await installGuard();
    await app.execute(
      sql.raw(
        "CREATE OR REPLACE FUNCTION public.akash_receipt_writer_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$"
      )
    );
    await expect(guardedClaim()).rejects.toThrow(/unqualified receipt guard/);
  });
  it("keeps 101 discharged legacy rows without saturating the corrected budget", async () => {
    await db.insert(akashTxAllocations).values(
      Array.from({ length: 101 }, (_, index) => ({
        walletScope: WALLET,
        cogniKey: `xcw:candidate-a:fixture:${index + 10}`,
        nodeId: identity.nodeId,
        compositeUid: `old-${index}`,
        compositeGeneration: 1,
        workload: "fixture",
        environment: "candidate-a",
        state: "released",
        externalName: String(9000 + index),
        nativeClosedVerified: true,
      }))
    );
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    await expect(
      guardedLedger.prepare({
        cogniKey: first.record.cogniKey,
        allocationCursor: "10000",
        expected: first.record,
        coverage: coverage(),
        deadlineAt: Date.now() + 30_000,
      })
    ).resolves.toMatchObject({ allocationNoEffectVerified: false });
    const old = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
    expect(
      old.filter((row) => row.allocationNoEffectVerified === null)
    ).toHaveLength(101);
    expect(old).toHaveLength(102);
  });

  it("counts two distinct eligible fixed targets, including unleased targets, before a proposed slot", async () => {
    await db.insert(akashTxAllocations).values(
      [1, 2].map((index) => ({
        walletScope: WALLET,
        cogniKey: `xcw:candidate-a:fixture:${index}`,
        nodeId: identity.nodeId,
        compositeUid: `older-${index}`,
        compositeGeneration: 1,
        workload: "fixture",
        environment: "candidate-a",
        state: "allocated",
        externalName: String(8000 + index),
      }))
    );
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const live = {
      ...coverage(),
      targets: [1, 2].map((index) => ({
        dseq: String(8000 + index),
        groups: [{ gseq: 1, state: "open" }],
        orders: [{ gseq: 1, oseq: 1, state: "open" }],
        leases: [],
      })),
    };
    await expect(
      guardedLedger.prepare({
        cogniKey: first.record.cogniKey,
        allocationCursor: "10000",
        expected: first.record,
        coverage: live,
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow(/live allocation bound/);
    expect(
      (await guardedLedger.read({ cogniKey: first.record.cogniKey }))
        ?.allocationNoEffectVerified
    ).toBe(true);
  });

  it("refuses an unknown target before excluding another family", async () => {
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    const unknown = {
      ...coverage(),
      targets: [
        {
          dseq: "8888",
          groups: [{ gseq: 1, state: "open" }],
          orders: [],
          leases: [],
        },
      ],
    };
    await expect(
      guardedLedger.prepare({
        cogniKey: first.record.cogniKey,
        allocationCursor: "10000",
        expected: first.record,
        coverage: unknown,
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow(/attribution unknown/);
  });

  it("keeps old NULL preparing custody held while qualifying independent bound rows fairly", async () => {
    await db.insert(akashTxAllocations).values(
      [1, 2, 3].map((index) => ({
        walletScope: WALLET,
        cogniKey: `xcw:candidate-a:fixture:${index}`,
        nodeId: identity.nodeId,
        compositeUid: `older-${index}`,
        compositeGeneration: 1,
        workload: "fixture",
        environment: "candidate-a",
        state: "allocated",
        externalName: String(8000 + index),
      }))
    );
    const old = await claim();
    if (old.state !== "claimed") throw new Error("fixture claim failed");
    await installGuard();
    expect((await guardedClaim()).state).toBe("blocked");
    await expect(
      guardedLedger.fail({
        cogniKey: "compatible",
        failureCode: "empty",
        expected: old.record,
      })
    ).rejects.toThrow(/custody/);
    const [first, second] = await guardedLedger.listClosureCandidates();
    if (!first || !second) throw new Error("qualification fixtures missing");
    expect(first.state).toBe("allocated");
    await expect(
      guardedLedger.startClosureRead(first, Date.now() - 1)
    ).rejects.toThrow(/deadline/);
    expect(
      (await guardedLedger.read({ cogniKey: first.cogniKey }))?.custody
    ).toEqual(first.custody);
    await guardedLedger.startClosureRead(first, Date.now() + 30_000);
    expect((await guardedLedger.listClosureCandidates())[0]?.receiptId).toBe(
      second.receiptId
    );
    expect((await ledger.read({ cogniKey: "compatible" }))?.custody).toEqual(
      old.record.custody
    );
  });

  it("refuses even legacy malformed same-scope lineage rather than filtering it away", async () => {
    await db.insert(akashTxAllocations).values({
      walletScope: WALLET,
      cogniKey: "malformed-family",
      nodeId: identity.nodeId,
      compositeUid: "older",
      compositeGeneration: 1,
      workload: "fixture",
      environment: "candidate-a",
      state: "failed",
    });
    await installGuard();
    const first = await guardedClaim();
    if (first.state !== "claimed") throw new Error("fixture claim failed");
    await expect(
      guardedLedger.prepare({
        cogniKey: first.record.cogniKey,
        allocationCursor: "10000",
        expected: first.record,
        coverage: coverage(),
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow(/family identity malformed/);
  });
});
