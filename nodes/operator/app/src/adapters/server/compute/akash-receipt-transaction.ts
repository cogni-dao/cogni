// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Database } from "@cogni/db-client";
import { and, eq, sql } from "drizzle-orm";
import type { AkashTxAllocationRecord } from "@/ports";
import { akashTxAllocations as table } from "@/shared/db/schema";
/**
 * Module: `@adapters/server/compute/akash-receipt-transaction`
 * Purpose: Order receipt protocol reads against DDL and fence every writer's original tuple.
 * Scope: Short PostgreSQL transactions only; installs no trigger and performs no provider IO.
 * Invariants: Context is compatibility, never authentication. Unknown guard bytes refuse.
 * Side-effects: IO (Postgres)
 * Links: subtask.5033; R3 seq4 F1/native admission.
 * @internal
 */
import {
  actorDatabaseAwait,
  checkActorDatabaseScope,
  trackActorDatabaseCallback,
} from "./akash-actor-scope";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Source contract for a LATER separately reviewed migration. This file never installs it. */
export const RECEIPT_CONTEXT = "compatible-receipts-v1";
export const RECEIPT_GUARD_BODY = `BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR current_setting('cogni.receipt_writer', true) IS DISTINCT FROM 'compatible-receipts-v1' THEN
    RAISE EXCEPTION 'incompatible receipt writer' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END`;

export async function receiptTransaction<T>(
  db: Database | Promise<Database>,
  run: (tx: Tx, guarded: boolean) => Promise<T>,
  deadlineAt?: number
): Promise<T> {
  return boundedReceiptTransaction(
    db,
    async (tx) => {
      checkActorDatabaseScope();
      // Held until commit. CREATE TRIGGER's conflicting lock cannot straddle the read/CAS.
      await actorDatabaseAwait(() =>
        tx.execute(
          sql`lock table public.akash_tx_allocations in row exclusive mode`
        )
      );
      await actorDatabaseAwait(() =>
        tx.execute(sql`set local search_path = pg_catalog, public`)
      );
      const triggers = await actorDatabaseAwait(() =>
        tx.execute<{
          name: string;
          enabled: string;
          type: number;
          body: string;
          language: string;
          security_definer: boolean;
          namespace: string;
          attributes: string;
          predicate: boolean;
          arguments: number;
          config: string[] | null;
        }>(sql`select t.tgname as name, t.tgenabled as enabled, t.tgtype::int as type,
       p.prosrc as body, l.lanname as language, p.prosecdef as security_definer, n.nspname as namespace, t.tgattr::text as attributes, t.tgqual is not null as predicate, t.tgnargs::int as arguments, p.proconfig as config
       from pg_trigger t join pg_proc p on p.oid=t.tgfoid
       join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
       where t.tgrelid='public.akash_tx_allocations'::regclass and not t.tgisinternal`)
      );
      const guard = triggers.find(
        (t) => t.name === "akash_receipt_writer_guard"
      );
      if (
        triggers.length !== (guard ? 1 : 0) ||
        (guard &&
          (guard.enabled !== "A" ||
            guard.type !== 62 ||
            guard.body !== RECEIPT_GUARD_BODY ||
            guard.language !== "plpgsql" ||
            guard.security_definer ||
            guard.namespace !== "public" ||
            guard.attributes !== "" ||
            guard.predicate ||
            guard.arguments !== 0 ||
            guard.config !== null))
      )
        throw new Error("unqualified receipt guard protocol");
      // Refuse inherited admitted context; SET LOCAL alone would restore that unsafe pool default.
      const [context] = await actorDatabaseAwait(() =>
        tx.execute<{
          writer: string | null;
          replication: string;
        }>(
          sql`select current_setting('cogni.receipt_writer', true) as writer, current_setting('session_replication_role') as replication`
        )
      );
      if (context?.writer || context?.replication !== "origin")
        throw new Error("unsafe receipt connection context");
      await actorDatabaseAwait(() =>
        tx.execute(
          sql`select set_config('cogni.receipt_writer', ${guard ? RECEIPT_CONTEXT : ""}, true)`
        )
      );
      return actorDatabaseAwait(() => run(tx, Boolean(guard)));
    },
    deadlineAt,
    "repeatable read"
  );
}

/**
 * Pool admission has no postgres.js cancellation primitive. Race ONLY admission, never
 * an executing mutation: a late callback must throw before running application SQL.
 * Statement/lock timeouts and the final deadline check roll back late query results.
 * PG15 per-statement timeouts do not prove a whole-transaction transport bound.
 * An in-flight query or COMMIT acknowledgement still needs native cancellation proof.
 */
export async function boundedReceiptTransaction<T>(
  db: Database | Promise<Database>,
  run: (tx: Tx) => Promise<T>,
  deadlineAt?: number,
  isolationLevel: "repeatable read" | "read committed" = "read committed"
): Promise<T> {
  const check = () => {
    checkActorDatabaseScope();
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new Error("receipt operation deadline exceeded");
  };
  check();
  let admitted!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const admission = new Promise<void>((resolve, reject) => {
    admitted = resolve;
    if (deadlineAt !== undefined)
      timer = setTimeout(
        () => reject(new Error("receipt pool deadline exceeded")),
        Math.max(0, deadlineAt - Date.now())
      );
  });
  const operation = Promise.resolve(db).then((database) => {
    check();
    return database.transaction(
      (tx) =>
        trackActorDatabaseCallback(async () => {
          admitted();
          check();
          if (deadlineAt !== undefined) {
            const milliseconds = Math.max(
              1,
              Math.min(2000, Math.floor(deadlineAt - Date.now()))
            );
            // SET is a utility command. SELECT set_config would freeze the RR snapshot
            // before receiptTransaction acquires its DDL-conflicting relation lock.
            await actorDatabaseAwait(() =>
              tx.execute(
                sql.raw(`set local statement_timeout = '${milliseconds}ms'`)
              )
            );
            await actorDatabaseAwait(() =>
              tx.execute(
                sql.raw(`set local lock_timeout = '${milliseconds}ms'`)
              )
            );
          }
          check();
          const result = await actorDatabaseAwait(() => run(tx));
          check(); // No late result is allowed to authorize COMMIT.
          return result;
        }),
      { isolationLevel }
    );
  });
  // A timed-out queued BEGIN can finish later, but its callback only rolls back.
  void operation.catch(() => undefined);
  try {
    await actorDatabaseAwait(() =>
      Promise.race([admission, operation.then(() => undefined)])
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return operation;
}

/** Every mutable part also fences the version, including exact NULL and explicit consumer. */
export function receiptFence(
  walletScope: string,
  key: string,
  expected?: AkashTxAllocationRecord
) {
  if (
    !expected?.custody ||
    expected.cogniKey !== key ||
    expected.custody.walletScope !== walletScope
  )
    throw new Error("receipt custody tuple required");
  return and(
    eq(table.walletScope, walletScope),
    eq(table.cogniKey, key),
    eq(table.id, expected.receiptId),
    sql`to_char(${table.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expected.custody.updatedAt}`,
    eq(table.state, expected.state),
    sql`${table.allocationCursor} is not distinct from ${expected.allocationCursor ?? null}`,
    sql`${table.externalName} is not distinct from ${expected.externalName ?? null}`,
    eq(table.nodeId, expected.identity.nodeId),
    eq(table.environment, expected.environment),
    eq(table.compositeUid, expected.identity.compositeUid),
    eq(table.compositeGeneration, expected.identity.compositeGeneration),
    eq(table.workload, expected.workload)
  );
}
export const receiptVersion = sql<string>`to_char(${table.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const advanceReceiptVersion = sql`greatest(clock_timestamp(), ${table.updatedAt} + interval '1 microsecond')`;
