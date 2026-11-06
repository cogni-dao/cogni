// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/advisory-leader`
 * Purpose: A recycled Postgres connection (new backend session, old session lock gone) must make the
 *   sequencer RE-ACQUIRE the advisory lock once on the same connection and keep leading; only a lock
 *   held by another session is lost leadership (task.5400 review B1).
 * Side-effects: none (a tiny in-memory Postgres lock model)
 */

import { describe, expect, it } from "vitest";

import { AdvisoryLeader } from "../../../../src/adapters/server/node-deploy/advisory-leader.adapter";

/** One connection whose backend can be replaced, like postgres.js recycling it. */
class FakeLockServer {
  holder: number | null = null;
  session = 1;
  readonly queries: string[] = [];

  /** The client reconnects: a new backend session; Postgres drops the old session's advisory locks. */
  recycleConnection(): void {
    if (this.holder === this.session) this.holder = null;
    this.session += 1;
  }
  /** Another process (a second sequencer) takes the lock from a different session. */
  otherProcessTakes(): void {
    expect(this.holder).toBeNull();
    this.holder = 999;
  }
  client() {
    return {
      unsafe: async (query: string) => {
        this.queries.push(query.includes("pg_locks") ? "held" : "try_lock");
        if (query.includes("pg_locks"))
          return [{ held: this.holder === this.session }];
        // pg_try_advisory_lock: re-entrant for the same session
        if (this.holder === null || this.holder === this.session) {
          this.holder = this.session;
          return [{ ok: true }];
        }
        return [{ ok: false }];
      },
    };
  }
}

function setup() {
  const server = new FakeLockServer();
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const leader = new AdvisoryLeader(server.client(), {
    info: (fields, msg) => lines.push({ msg, fields }),
    warn: (fields, msg) => lines.push({ msg, fields }),
  });
  return { server, leader, lines };
}

describe("AdvisoryLeader", () => {
  it("acquires once and then simply reports held", async () => {
    const { leader, server } = setup();
    expect(await leader.tryAcquire()).toBe(true);
    expect(await leader.assert()).toBe(true);
    expect(server.queries).toEqual(["try_lock", "held"]);
  });

  it("a RECYCLED connection re-acquires the lock on the same connection instead of exiting, and logs it", async () => {
    const { leader, server, lines } = setup();
    await leader.tryAcquire();
    server.recycleConnection(); // postgres.js reconnected: new session, lock gone
    expect(server.holder).toBeNull();
    expect(await leader.assert()).toBe(true); // keeps leading
    expect(server.holder).toBe(server.session); // and holds it again, on the new backend
    expect(lines.map((l) => l.msg)).toEqual([
      "node_deploy_sequencer_lock_reacquired",
    ]);
    // idempotent: the next heartbeat just sees it held
    expect(await leader.assert()).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("survives repeated recycling (hourly connection churn)", async () => {
    const { leader, server } = setup();
    await leader.tryAcquire();
    for (let i = 0; i < 5; i++) {
      server.recycleConnection();
      expect(await leader.assert()).toBe(true);
    }
    expect(server.holder).toBe(server.session);
  });

  it("another process taking the lock during the gap IS lost leadership (assert returns false, logged)", async () => {
    const { leader, server, lines } = setup();
    await leader.tryAcquire();
    server.recycleConnection();
    server.otherProcessTakes(); // a second sequencer won the race
    expect(await leader.assert()).toBe(false);
    expect(server.holder).toBe(999); // we did not steal it
    expect(lines.map((l) => l.msg)).toEqual([
      "node_deploy_sequencer_lock_refused",
    ]);
  });

  it("a standby cannot acquire while another session leads", async () => {
    const { leader, server } = setup();
    server.otherProcessTakes();
    expect(await leader.tryAcquire()).toBe(false);
  });
});
