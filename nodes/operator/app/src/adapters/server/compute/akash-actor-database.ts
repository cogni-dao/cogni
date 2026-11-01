// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-actor-database`
 * Purpose: Own the actuator's sole local database slot across all borrowers.
 * Scope: Removable admission and fresh typed roots; no provider IO or remote reclamation.
 * Invariants: One absolute deadline includes COMMIT ACK. Every exit seals before disposal.
 *   Only concrete borrower methods are public. Every query is checked before and after
 *   materialization. Local close proves no remote rollback.
 * Side-effects: IO (one owned PostgreSQL transport)
 * Links: subtask.5033, paid-allocation-admission F1 seq5
 * @internal
 */
import { connect, type Socket } from "node:net";
import { createAppDbClient, type Database } from "@cogni/db-client";
import { sql } from "drizzle-orm";
import { AkashTxError } from "@/ports";
import { ACCOUNT_WALLET_SCOPE_PATTERN } from "@/shared/db/akash-tx-allocations";
import { akashTxAllocations } from "@/shared/db/schema";
import { DrizzleNodeMigrationReportStore } from "../observability/drizzle-node-migration-report.adapter";
import { actorDatabaseAwait, inActorDatabaseScope } from "./akash-actor-scope";
import { DrizzleAkashTxAllocationLedger } from "./akash-tx-allocation-ledger.adapter";
import { DrizzleComputeCostStore } from "./compute-cost-store.adapter";
import { DrizzleDatabaseCellBindingStore } from "./database-cell-binding-store.adapter";
import { DrizzleProviderOutcomeStore } from "./provider-outcome-store";

function held(cause?: unknown): AkashTxError {
  const error = new AkashTxError(
    "outcome_unknown",
    "HELD: database acknowledgement unavailable; retain allocation custody"
  );
  return Object.assign(error, { cause });
}

function acknowledgementUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      [
        "53300",
        "57014",
        "55P03",
        "57P03",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "CONNECTION_DESTROYED",
        "CONNECTION_CLOSED",
        "CONNECTION_ENDED",
        "CONNECT_TIMEOUT",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "08006",
        "08003",
        "57P01",
      ].includes(current.code)
    )
      return true;
    current = current.cause;
  }
  return false;
}

interface Waiter {
  deadlineAt: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AkashActorDatabase {
  #active = false;
  readonly #waiters: Waiter[] = [];

  readonly #connectionString: string;
  readonly #createClient: typeof createAppDbClient;

  constructor(
    connectionString: string,
    createClient: typeof createAppDbClient = createAppDbClient
  ) {
    this.#connectionString = connectionString;
    this.#createClient = createClient;
  }

  /** Concrete allocationLedger operations share the sole local admission token. */
  allocationLedger(
    walletScope: string
  ): Pick<
    DrizzleAkashTxAllocationLedger,
    keyof DrizzleAkashTxAllocationLedger
  > {
    return {
      claim: (...args: Parameters<DrizzleAkashTxAllocationLedger["claim"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).claim(...args)
        ),
      bindIdentity: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["bindIdentity"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).bindIdentity(...args)
        ),
      prepare: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["prepare"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).prepare(...args)
        ),
      listClosureCandidates: (
        ...args: Parameters<
          DrizzleAkashTxAllocationLedger["listClosureCandidates"]
        >
      ) =>
        this.#run(args[0] ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).listClosureCandidates(...args)
        ),
      startClosureRead: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["startClosureRead"]>
      ) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).startClosureRead(...args)
        ),
      certifyNativeClosed: (
        ...args: Parameters<
          DrizzleAkashTxAllocationLedger["certifyNativeClosed"]
        >
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).certifyNativeClosed(...args)
        ),
      recordAllocation: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["recordAllocation"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).recordAllocation(...args)
        ),
      adoptAllocation: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["adoptAllocation"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).adoptAllocation(...args)
        ),
      recordAppliedSdlHash: (
        ...args: Parameters<
          DrizzleAkashTxAllocationLedger["recordAppliedSdlHash"]
        >
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).recordAppliedSdlHash(...args)
        ),
      listStalePreparing: (
        ...args: Parameters<
          DrizzleAkashTxAllocationLedger["listStalePreparing"]
        >
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).listStalePreparing(...args)
        ),
      fail: (...args: Parameters<DrizzleAkashTxAllocationLedger["fail"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).fail(...args)
        ),
      markReleased: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["markReleased"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).markReleased(...args)
        ),
      listAllocated: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["listAllocated"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).listAllocated(...args)
        ),
      listActive: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["listActive"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).listActive(...args)
        ),
      listReceipts: (
        ...args: Parameters<DrizzleAkashTxAllocationLedger["listReceipts"]>
      ) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).listReceipts(...args)
        ),
      read: (...args: Parameters<DrizzleAkashTxAllocationLedger["read"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleAkashTxAllocationLedger(
            () => Promise.resolve(db),
            walletScope
          ).read(...args)
        ),
    };
  }

  /** Concrete costStore operations share the sole local admission token. */
  costStore(): Pick<DrizzleComputeCostStore, keyof DrizzleComputeCostStore> {
    return {
      bind: (...args: Parameters<DrizzleComputeCostStore["bind"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleComputeCostStore(() => Promise.resolve(db)).bind(...args)
        ),
      observe: (...args: Parameters<DrizzleComputeCostStore["observe"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleComputeCostStore(() => Promise.resolve(db)).observe(
            ...args
          )
        ),
      close: (...args: Parameters<DrizzleComputeCostStore["close"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleComputeCostStore(() => Promise.resolve(db)).close(...args)
        ),
      reportByNode: (
        ...args: Parameters<DrizzleComputeCostStore["reportByNode"]>
      ) =>
        this.#run(args[0] ?? Date.now() + 30_000, (db) =>
          new DrizzleComputeCostStore(() => Promise.resolve(db)).reportByNode(
            ...args
          )
        ),
      reportByNodeIds: (
        ...args: Parameters<DrizzleComputeCostStore["reportByNodeIds"]>
      ) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleComputeCostStore(() =>
            Promise.resolve(db)
          ).reportByNodeIds(...args)
        ),
    };
  }

  /** Concrete bindingStore operations share the sole local admission token. */
  bindingStore(
    walletScope: string
  ): Pick<
    DrizzleDatabaseCellBindingStore,
    keyof DrizzleDatabaseCellBindingStore
  > {
    return {
      read: (...args: Parameters<DrizzleDatabaseCellBindingStore["read"]>) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleDatabaseCellBindingStore(
            () => Promise.resolve(db),
            walletScope
          ).read(...args)
        ),
      save: (...args: Parameters<DrizzleDatabaseCellBindingStore["save"]>) =>
        this.#run(args[3] ?? Date.now() + 30_000, (db) =>
          new DrizzleDatabaseCellBindingStore(
            () => Promise.resolve(db),
            walletScope
          ).save(...args)
        ),
    };
  }

  /** Concrete outcomeStore operations share the sole local admission token. */
  outcomeStore(): Pick<
    DrizzleProviderOutcomeStore,
    keyof DrizzleProviderOutcomeStore
  > {
    return {
      record: (...args: Parameters<DrizzleProviderOutcomeStore["record"]>) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleProviderOutcomeStore(() => Promise.resolve(db)).record(
            ...args
          )
        ),
      stats: (...args: Parameters<DrizzleProviderOutcomeStore["stats"]>) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleProviderOutcomeStore(() => Promise.resolve(db)).stats(
            ...args
          )
        ),
    };
  }

  /** Concrete migrationReportStore operations share the sole local admission token. */
  migrationReportStore(): Pick<
    DrizzleNodeMigrationReportStore,
    keyof DrizzleNodeMigrationReportStore
  > {
    return {
      record: (
        ...args: Parameters<DrizzleNodeMigrationReportStore["record"]>
      ) =>
        this.#run(args[1] ?? Date.now() + 30_000, (db) =>
          new DrizzleNodeMigrationReportStore(() => Promise.resolve(db)).record(
            ...args
          )
        ),
      read: (...args: Parameters<DrizzleNodeMigrationReportStore["read"]>) =>
        this.#run(args[0].deadlineAt ?? Date.now() + 30_000, (db) =>
          new DrizzleNodeMigrationReportStore(() => Promise.resolve(db)).read(
            ...args
          )
        ),
    };
  }

  async countLegacyScopedReceipts(deadlineAt: number): Promise<number> {
    return this.#run(deadlineAt, async (db) => {
      const [row] = await actorDatabaseAwait(() =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(akashTxAllocations)
          .where(
            sql`${akashTxAllocations.walletScope} !~ ${ACCOUNT_WALLET_SCOPE_PATTERN}`
          )
      );
      return row?.count ?? 0;
    });
  }

  #admit(deadlineAt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { deadlineAt, resolve, reject };
      waiter.timer = setTimeout(
        () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(held());
        },
        Math.max(0, deadlineAt - Date.now())
      );
      this.#waiters.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#active) return;
    for (
      let waiter = this.#waiters.shift();
      waiter;
      waiter = this.#waiters.shift()
    ) {
      clearTimeout(waiter.timer);
      if (Date.now() >= waiter.deadlineAt) {
        waiter.reject(held());
        continue;
      }
      this.#active = true;
      waiter.resolve();
      return;
    }
  }

  async #run<T>(
    deadlineAt: number,
    work: (db: Database) => Promise<T>
  ): Promise<T> {
    if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw held();
    deadlineAt = Math.min(deadlineAt, Date.now() + 30_000);
    await this.#admit(deadlineAt);
    let revoked = false;
    let deadlineExpired = false;
    let socket: Socket | undefined;
    let disposal: Promise<void> | undefined;
    let db: Database | undefined;
    let pendingWork: Promise<T> | undefined;
    const callbacks = new Set<Promise<void>>();
    let factoryWork: Promise<Socket> | undefined;
    let adopted = false;
    const check = () => {
      if (revoked || Date.now() >= deadlineAt) throw held();
    };
    const seal = (): Promise<void> => {
      revoked = true;
      disposal ??= (async () => {
        // A raw socket still inside our factory has no TLS wrapper or pending driver write.
        // Once handed to postgres.js, only its public graceful end owns TLS retirement.
        if (socket && !adopted) socket.destroy();
        const ending = db?.$client.end();
        // Observe the public drain even if a refused factory leaves its promise pending.
        // Actual disposal is source-work completion plus physical close, not that promise.
        void ending?.catch(() => undefined);
        await pendingWork?.catch(() => undefined);
        await Promise.all(callbacks);
        await factoryWork?.catch(() => undefined);
        // Driver TLS setup removes raw listeners. Public closed state survives that removal.
        while (socket && !socket.closed) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      })();
      return disposal;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          deadlineExpired = true;
          // Latch BEFORE end() rejects native promises; its error cannot win classification.
          void seal().catch(() => undefined);
          reject(held());
        },
        Math.max(0, deadlineAt - Date.now())
      );
    });
    const operation = Promise.resolve().then(async () => {
      check();
      const target = new URL(this.#connectionString);
      const hostname = target.hostname.replace(/^\[|\]$/g, "");
      const verifiedTls =
        (target.searchParams.has("sslmode") &&
          target.searchParams.get("sslmode") !== "disable") ||
        target.searchParams.get("sslrootcert") === "system";
      const options = {
        max: 1,
        // These borrowers use scalar/JSONB columns, not SQL arrays. postgres3.4.7's
        // automatic array discovery owns an unobserved promise on transport disposal.
        fetchTypes: false,
        applicationName: "cogni_operator_akash_tx_actuator",
        ...(verifiedTls
          ? { ssl: { servername: hostname, rejectUnauthorized: true } }
          : {}),
        socket: () => {
          check();
          // One factory invocation per generation, including connecting and failed sockets.
          if (factoryWork) throw held();
          factoryWork = (async () => {
            check();
            const transport = connect({
              host: hostname,
              port: Number(target.port || 5432),
            });
            socket = transport;
            // Attach rejection observation before connect can fail. No fatal TLS handler.
            try {
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  transport.removeListener("connect", connected);
                  transport.removeListener("error", failed);
                  transport.removeListener("close", closed);
                };
                const connected = () => {
                  cleanup();
                  resolve();
                };
                const failed = (error: Error) => {
                  cleanup();
                  reject(error);
                };
                const closed = () => {
                  cleanup();
                  reject(held());
                };
                // Expiry may close an unadopted DNS/TCP socket without an error event.
                transport.once("connect", connected);
                transport.once("error", failed);
                transport.once("close", closed);
              });
              check();
              adopted = true;
              return transport;
            } catch (error) {
              // This transport has never been transferred to the driver's TLS owner.
              transport.destroy();
              throw error;
            }
          })();
          return factoryWork;
        },
      };
      const database = this.#createClient(this.#connectionString, options);
      db = database;
      pendingWork = inActorDatabaseScope(check, callbacks, async () => {
        // Force DNS/TCP/TLS/auth and native setup to finish before queuing application SQL.
        // SET is a utility statement; it cannot establish a receipt RR snapshot.
        await actorDatabaseAwait(() =>
          database.execute(
            sql`set application_name = 'cogni_operator_akash_tx_actuator'`
          )
        );
        return actorDatabaseAwait(() => work(database));
      });
      const result = await pendingWork;
      check();
      await seal();
      if (Date.now() >= deadlineAt) throw held();
      return result;
    });
    // Expiry can return before a delayed callback/factory settles; both remain revoked.
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, expiry]);
    } catch (error) {
      if (
        deadlineExpired ||
        Date.now() >= deadlineAt ||
        acknowledgementUnavailable(error)
      )
        throw held(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // A stalled disposal retains admission; waiting callers still expire on their budget.
      // Release ONLY on observed local close. An ordinary disposal permits recovery.
      void seal().then(
        () => {
          this.#active = false;
          this.#drain();
        },
        () => undefined
      );
    }
  }
}
