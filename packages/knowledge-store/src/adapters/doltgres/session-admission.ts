// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/session-admission`
 * Purpose: Admission control for Dolt branch work — bound concurrency ABOVE the connection pool so a burst of writers queues instead of starving the pool.
 * Scope: FIFO queue, cross-replica advisory lock, bounded reserve, and client recreation for session-pinned operations. Does not gate ordinary pooled reads — a write-side proof must never decide whether a read is served (bug.5358).
 * Invariants:
 *   - DOLT_SESSION_ADMISSION: admit one operation BEFORE reserving, never after.
 *     Reserving first is what wedges the pool; see `DoltBranchSessionRunner`.
 *   - `KNOWLEDGE_BRANCH_LOCK_KEY` must differ from every other advisory-lock key
 *     used against the same Doltgres database — `@cogni/work-items` owns
 *     `5_001_001` and shares `DOLTGRES_URL` with this package.
 *   - The runner owns the only `sql.reserve()` call in this package.
 * Side-effects: IO (database connections), time (deadlines + lock retry backoff)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import type { ReservedSql, Sql } from "postgres";
import { KnowledgeBusyError } from "../../port/knowledge-store.port.js";

/**
 * Advisory-lock key for knowledge branch operations.
 *
 * PostgreSQL advisory locks are per-database, and operator points both
 * `@cogni/work-items` and this package at the same `DOLTGRES_URL`. Work items
 * hold `5_001_001`; taking the same key here would make a work-item write and a
 * knowledge write exclude each other for no reason.
 */
export const KNOWLEDGE_BRANCH_LOCK_KEY = 5_001_002;

/** How long a queued operation waits for its turn before giving up. */
export const QUEUE_WAIT_MS = 30_000;
/**
 * How long to wait for a session-pinned connection once admitted.
 *
 * Covers the priming query AND the reserve: on an exhausted pool the prime is
 * what hangs, so bounding only the reserve bounds nothing.
 */
export const ACQUIRE_TIMEOUT_MS = 5_000;
/** How long to spin for the cross-replica advisory lock. */
export const LOCK_WAIT_MS = 2_000;
/** Gap between advisory-lock attempts. */
export const LOCK_RETRY_MS = 50;

export interface BranchSessionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const noopLogger: BranchSessionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BranchSessionOptions {
  readonly logger?: BranchSessionLogger;
  readonly queueWaitMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly lockKey?: number;
  /**
   * Rebuilds the client after a wedged session is terminated. Without it a
   * terminated pool cannot be replaced, so the runner declines to terminate and
   * only fails the operation.
   */
  readonly recreateClient?: () => Sql;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

function doltBoolean(rows: unknown, field: string): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
}

/**
 * Serializes Dolt branch operations and hands each one a proven session.
 *
 * WHY ADMISSION CONTROL AND NOT A BIGGER POOL (bug.5391, mirroring the proven
 * `@cogni/work-items` shape):
 *
 * Every Dolt branch operation needs a session-pinned connection, because
 * `dolt_checkout` is session state. postgres.js exposes that as `reserve()`,
 * and a reserved connection is pinned for the WHOLE operation — on Doltgres
 * that is several seconds of `dolt_merge`/`dolt_commit`/`dolt_branch` under
 * load (bug.5395 measured a lease p99 of 4330ms).
 *
 * Two failure modes compound on the shared `max: 5` pool that also serves
 * reads:
 *
 *   - Starvation. Concurrent branch ops hold their reserved connections for
 *     seconds. Once every slot is held, the next caller's query is parked on
 *     postgres.js's UNBOUNDED `queries` backlog with no deadline of its own —
 *     so reads hang right alongside the writes. That is the prod signature:
 *     four `knowledge.contributions.close` calls timing out in the same second
 *     while the list route intermittently stopped answering (bug.5391).
 *   - A cold `reserve()` that never settles. On a `fetch_types: false` client —
 *     mandatory for Doltgres — `ReadyForQuery` skips `fetchArrayTypes()`, so
 *     `onopen` never fires, and `onopen` is the only caller of
 *     `query.reserve(c)`. `connect_timeout` was already cancelled, so nothing
 *     rescues it and the slot is gone for the process lifetime (bug.5386).
 *
 * Priming with a plain query before reserving fixes the second mode. It does
 * nothing for the first, which is why PR #2611 converted an infinite hang into
 * a bounded 15s error without stopping the outage.
 *
 * Raising `max` only defers the wedge and multiplies reserved sessions on a
 * latency-prone substrate. The fix is to bound concurrency ABOVE the pool:
 *
 *   1. FIFO queue — admit ONE operation before it reserves, so a burst queues
 *      instead of racing. Bounded by `queueWaitMs` so a caller fails fast.
 *   2. Prime, then reserve, under ONE deadline covering both. The deadline must
 *      span the prime: on an already-exhausted pool the priming query is itself
 *      parked on the unbounded backlog, so bounding only the reserve still
 *      hangs. Missing the deadline means the pool is wedged: terminate the
 *      client and rebuild it, rather than hand the next caller a pool with one
 *      fewer slot.
 *   3. `pg_try_advisory_lock` — the same one-at-a-time guarantee across
 *      replicas, which an in-process queue cannot give.
 *
 * The pool behind this runner is then deliberately `max: 1`, and it is NOT the
 * pool that serves reads.
 */
export class DoltBranchSessionRunner {
  private sql: Sql;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly logger: BranchSessionLogger;
  private readonly queueWaitMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly lockKey: number;
  private readonly recreateClient: (() => Sql) | undefined;
  private readonly terminatingPools = new WeakMap<object, Promise<void>>();

  constructor(sql: Sql, options: BranchSessionOptions = {}) {
    this.sql = sql;
    this.logger = options.logger ?? noopLogger;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.lockKey = options.lockKey ?? KNOWLEDGE_BRANCH_LOCK_KEY;
    this.recreateClient = options.recreateClient;
  }

  /** The client currently backing branch work. Swapped on termination. */
  get client(): Sql {
    return this.sql;
  }

  /**
   * Run `fn` on a session-pinned connection, one operation at a time.
   *
   * Throws `KnowledgeBusyError` when admission, reservation, or the advisory
   * lock could not be obtained — in every one of those cases nothing was
   * applied, so the caller may retry.
   */
  async run<T>(
    operation: string,
    fn: (conn: ReservedSql) => Promise<T>
  ): Promise<T> {
    const leaveQueue = await this.enterQueue(operation);
    try {
      return await this.withSession(operation, fn);
    } finally {
      leaveQueue();
    }
  }

  private log(
    level: "info" | "warn" | "error",
    operation: string,
    stage: string,
    state: "start" | "complete" | "error",
    fields: Record<string, unknown> = {}
  ): void {
    this.logger[level](
      {
        event: "adapter.knowledge.branch_session",
        component: "doltgres-knowledge-store",
        operation,
        stage,
        state,
        ...fields,
      },
      `knowledge ${stage} ${state}`
    );
  }

  /**
   * FIFO admission. Chains onto the previous ticket so operations run in
   * arrival order; a caller that times out still releases its own ticket so the
   * chain cannot deadlock behind an abandoned turn.
   */
  private async enterQueue(operation: string): Promise<() => void> {
    const predecessor = this.operationTail;
    let releaseTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.operationTail = predecessor.then(() => turnDone);

    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        predecessor,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new KnowledgeBusyError(
                  "Knowledge write queue wait timed out; retry shortly"
                )
              ),
            this.queueWaitMs
          );
        }),
      ]);
    } catch (error) {
      // Keep the FIFO chain live even though this caller abandoned its turn.
      releaseTurn();
      this.log("warn", operation, "queue", "error", {
        durationMs: Date.now() - startedAt,
        reason: "wait_timeout",
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    this.log("info", operation, "queue", "complete", {
      durationMs: Date.now() - startedAt,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  private async withSession<T>(
    operation: string,
    fn: (conn: ReservedSql) => Promise<T>
  ): Promise<T> {
    const pool = this.sql;
    const startedAt = Date.now();
    let conn: ReservedSql | undefined;
    let locked = false;

    try {
      conn = await this.acquireSession(pool, operation);
      locked = await this.acquireLock(conn, operation);
      return await fn(conn);
    } finally {
      if (locked && conn && this.sql === pool) {
        try {
          await conn.unsafe(`SELECT pg_advisory_unlock(${this.lockKey})`);
        } catch (error) {
          // Never return a session that may still own the lock to the pool.
          this.log("error", operation, "lock.release", "error", {
            ...errorFields(error),
          });
          await this.terminateClient(
            pool,
            operation,
            "lock.release",
            "unlock_failed"
          );
          conn = undefined;
        }
      }
      if (conn && this.sql === pool) {
        try {
          await conn.unsafe(`SELECT dolt_checkout('main')`);
        } catch {
          /* best effort: the next operation checks out explicitly */
        }
        conn.release();
      }
      this.log("info", operation, "session", "complete", {
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Prime, then reserve, under a single deadline.
   *
   * PRIME_BEFORE_RESERVE: an ordinary query reaches postgres.js `onopen`, which
   * a cold `reserve()` does not. The deadline spans the prime because on an
   * exhausted pool the prime is what parks. Missing it means the client is
   * wedged, so it is condemned and rebuilt rather than handed on.
   */
  private async acquireSession(
    pool: Sql,
    operation: string
  ): Promise<ReservedSql> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KnowledgeBusyError(
              `Knowledge write plane timed out after ${this.acquireTimeoutMs}ms acquiring a session-pinned connection; retry shortly`
            )
          ),
        this.acquireTimeoutMs
      );
    });

    const acquire = (async () => {
      await pool.unsafe("SELECT 1 AS knowledge_ready");
      return await pool.reserve();
    })();

    try {
      return await Promise.race([acquire, expiry]);
    } catch (error) {
      // The losing acquire may still settle; hand its slot straight back so a
      // timed-out call cannot leak one on top of the failure.
      void acquire.then(
        (late) => late.release(),
        () => undefined
      );
      await this.terminateClient(pool, operation, "acquire", "acquire_timeout");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async acquireLock(
    conn: ReservedSql,
    operation: string
  ): Promise<boolean> {
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      const rows = await conn.unsafe(
        `SELECT pg_try_advisory_lock(${this.lockKey})`
      );
      if (doltBoolean(rows, "pg_try_advisory_lock")) return true;
      if (Date.now() >= deadline) {
        this.log("warn", operation, "lock.acquire", "error", {
          durationMs: this.lockWaitMs,
          reason: "contended",
        });
        throw new KnowledgeBusyError(
          `Knowledge write lane remained busy for ${this.lockWaitMs}ms; retry shortly`
        );
      }
      await sleep(
        Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now()))
      );
    }
  }

  /**
   * End a wedged client and rebuild it, so the next caller gets a whole pool
   * rather than one with a permanently burnt slot. Declines to terminate when
   * no factory was supplied — a dead pool with no replacement is worse than a
   * degraded one.
   */
  private async terminateClient(
    pool: Sql,
    operation: string,
    stage: string,
    reason: string
  ): Promise<void> {
    if (!this.recreateClient) {
      this.log("error", operation, stage, "error", {
        reason,
        terminated: false,
        detail: "no recreateClient factory; pool left in place",
      });
      return;
    }
    const active = this.terminatingPools.get(pool as object);
    if (active) return active;

    const termination = (async () => {
      this.log("error", operation, "connection.terminate", "error", {
        failedStage: stage,
        reason,
      });
      try {
        await pool.end({ timeout: 0 });
      } catch (error) {
        this.log("error", operation, "connection.terminate", "error", {
          failedStage: stage,
          reason: "terminate_failed",
          ...errorFields(error),
        });
        return;
      }
      if (this.sql !== pool) return;
      try {
        this.sql = this.recreateClient?.() ?? pool;
        this.log("info", operation, "connection.recreate", "complete", {
          failedStage: stage,
        });
      } catch (error) {
        this.log("error", operation, "connection.recreate", "error", {
          failedStage: stage,
          ...errorFields(error),
        });
      }
    })();
    this.terminatingPools.set(pool as object, termination);
    return termination;
  }
}
