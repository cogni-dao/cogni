// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/advisory-leader.adapter`
 * Purpose: Single-instance leadership for the node-deploy sequencer on ONE Postgres connection
 *   (task.5400): a session advisory lock plus a check that THIS backend still holds it.
 * Scope: SQL only. The caller decides what losing leadership means (the bootstrap exits).
 * Invariants:
 *   - ONE_CONNECTION: everything runs through the injected single-connection client; nothing is reserved.
 *   - RECYCLED_CONNECTION_IS_NOT_LOST_LEADERSHIP: postgres.js recycles connections (idle timeout, no
 *     max_lifetime), and a new backend session does not carry the old session's advisory lock. When the
 *     check finds the lock not held by this backend, `assert` calls `pg_try_advisory_lock` ONCE on the same
 *     connection. Only a refused lock (another process holds it) is lost leadership. The re-acquisition is
 *     logged either way.
 *   - NO_BLIND_WORK: `assert` is awaited before every tick/reconcile pass and on a 5 s heartbeat.
 * Side-effects: IO (Postgres)
 * @internal
 */

export interface SingleConnection {
  unsafe(query: string): Promise<readonly Record<string, unknown>[]>;
}

export interface LeaderLog {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

const LOCK_KEY = "hashtext('node-deploy-sequencer')::bigint";

export const HELD_SQL = `select exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and objsubid = 1 and objid::bigint = (${LOCK_KEY} & 4294967295) and classid::bigint = ((${LOCK_KEY} >> 32) & 4294967295)) as held`;
export const TRY_LOCK_SQL = `select pg_try_advisory_lock(${LOCK_KEY}) as ok`;

export class AdvisoryLeader {
  constructor(
    private readonly sql: SingleConnection,
    private readonly log: LeaderLog
  ) {}

  async held(): Promise<boolean> {
    const rows = await this.sql.unsafe(HELD_SQL);
    return rows[0]?.held === true;
  }

  async tryAcquire(): Promise<boolean> {
    const rows = await this.sql.unsafe(TRY_LOCK_SQL);
    return rows[0]?.ok === true;
  }

  /**
   * True while this process is the single leader. A backend that lost the lock because its connection
   * was recycled takes it back; a refused lock returns false (the caller must stop).
   */
  async assert(): Promise<boolean> {
    if (await this.held()) return true;
    const reacquired = await this.tryAcquire();
    if (reacquired) {
      this.log.warn(
        { reason: "ConnectionRecycled" },
        "node_deploy_sequencer_lock_reacquired"
      );
      return true;
    }
    this.log.warn(
      { reason: "LockHeldByAnotherSession" },
      "node_deploy_sequencer_lock_refused"
    );
    return false;
  }
}
