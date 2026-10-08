// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/session-admission`
 * Purpose: Pin the admission-control invariants that keep the Doltgres knowledge write plane from wedging (bug.5386, bug.5391).
 * Scope: Harness-level proof against a fake PG wire server. Does not connect to Doltgres and does not assert contribution semantics — `doltgres-contribution-concurrency.int.test.ts` owns those.
 * Invariants:
 *   - A bare `sql.reserve()` as the first operation on a `fetch_types: false`
 *     client NEVER settles. This is the defect; the first test documents it so
 *     the fix cannot be mistaken for cargo cult.
 *   - Priming alone is NOT enough: concurrent primes land on one connection, so
 *     a burst still burns a slot per cold reserve. That is why admission
 *     control sits ABOVE the pool rather than the pool being made bigger.
 *   - `DoltBranchSessionRunner` admits one operation at a time, fails loud with
 *     `KnowledgeBusyError` instead of hanging, and rebuilds a wedged client.
 * Side-effects: IO (binds a loopback TCP server on an ephemeral port)
 * Links: packages/knowledge-store/src/adapters/doltgres/session-admission.ts
 * @internal
 */

import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDoltgresClient } from "../src/adapters/doltgres/build-client.js";
import { DoltBranchSessionRunner } from "../src/adapters/doltgres/session-admission.js";
import { KnowledgeBusyError } from "../src/port/knowledge-store.port.js";

// ---------------------------------------------------------------------------
// Minimal Postgres wire server: completes startup (trust auth) and answers any
// subsequent client traffic with an empty result set — except
// `pg_try_advisory_lock`, which must answer `t` or the runner would correctly
// refuse to proceed. Enough to drive postgres.js's pool state machine, which is
// the only thing under test.
// ---------------------------------------------------------------------------

function msg(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([Buffer.from(type, "ascii"), len, body]);
}

function int32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
}

function int16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(value, 0);
  return b;
}

const AUTH_OK = msg("R", int32(0));
const BACKEND_KEY = msg("K", Buffer.concat([int32(1234), int32(5678)]));
const READY_IDLE = msg("Z", Buffer.from("I", "ascii"));
const PARSE_COMPLETE = msg("1", Buffer.alloc(0));
const BIND_COMPLETE = msg("2", Buffer.alloc(0));
const NO_DATA = msg("n", Buffer.alloc(0));
const CMD_COMPLETE = msg("C", Buffer.from("SELECT 0\0", "ascii"));

/** One bool column named `pg_try_advisory_lock`. */
const LOCK_ROW_DESCRIPTION = msg(
  "T",
  Buffer.concat([
    int16(1),
    Buffer.from("pg_try_advisory_lock\0", "ascii"),
    int32(0), // table oid
    int16(0), // column attribute number
    int32(16), // bool
    int16(1), // type size
    int32(-1), // type modifier
    int16(0), // text format
  ])
);

const LOCK_DATA_ROW = msg(
  "D",
  Buffer.concat([int16(1), int32(1), Buffer.from("t", "ascii")])
);

function parameterStatus(key: string, value: string): Buffer {
  return msg("S", Buffer.from(`${key}\0${value}\0`, "ascii"));
}

const STARTUP_RESPONSE = Buffer.concat([
  AUTH_OK,
  parameterStatus("server_version", "15.0"),
  parameterStatus("client_encoding", "UTF8"),
  parameterStatus("standard_conforming_strings", "on"),
  BACKEND_KEY,
  READY_IDLE,
]);

const QUERY_RESPONSE = Buffer.concat([
  PARSE_COMPLETE,
  BIND_COMPLETE,
  NO_DATA,
  CMD_COMPLETE,
  READY_IDLE,
]);

const LOCK_RESPONSE = Buffer.concat([
  PARSE_COMPLETE,
  BIND_COMPLETE,
  LOCK_ROW_DESCRIPTION,
  LOCK_DATA_ROW,
  msg("C", Buffer.from("SELECT 1\0", "ascii")),
  READY_IDLE,
]);

function startFakePostgres(): Promise<{
  server: net.Server;
  port: number;
  sockets: Set<net.Socket>;
}> {
  return new Promise((resolve) => {
    // Several tests deliberately strand connections (that IS the defect), so
    // `server.close()` would wait on them forever. Track and destroy instead.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let startupDone = false;
      socket.on("data", (buf) => {
        if (!startupDone) {
          startupDone = true;
          socket.write(STARTUP_RESPONSE);
          return;
        }
        // Any Sync ('S') or simple Query ('Q') byte terminates a client
        // message batch; answer it with an empty result + ReadyForQuery.
        if (buf.includes(0x53) || buf.includes(0x51)) {
          socket.write(
            buf.includes("pg_try_advisory_lock")
              ? LOCK_RESPONSE
              : QUERY_RESPONSE
          );
        }
      });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake postgres failed to bind an ephemeral port");
      }
      resolve({ server, port: address.port, sockets });
    });
  });
}

/** Resolve to `"settled"` or `"pending"` within `ms`, never throwing. */
async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const
      ),
      pending,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Dolt session admission control (bug.5386, bug.5391)", () => {
  let server: net.Server;
  let port: number;
  let sockets: Set<net.Socket>;

  beforeAll(async () => {
    ({ server, port, sockets } = await startFakePostgres());
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(max = 5) {
    return buildDoltgresClient({
      connectionString: `postgres://u:p@127.0.0.1:${port}/db`,
      max,
    });
  }

  it("documents the postgres.js defect: a bare cold sql.reserve() never settles", async () => {
    const sql = client();
    try {
      // No query has run, so `open` is empty and postgres.js cold-connects a
      // slot with a `{ reserve }` pseudo-query. With `fetch_types: false`
      // (mandatory for Doltgres) `ReadyForQuery` returns without calling
      // `onopen`, so nothing ever invokes `query.reserve(c)`.
      const reserved = sql.reserve();
      expect(await outcomeWithin(reserved, 2_000)).toBe("pending");
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("documents the plane-wide wedge: cold reserves burn every slot and then reads hang too", async () => {
    const max = 3;
    const sql = client(max);
    try {
      for (let i = 0; i < max; i++) {
        void sql.reserve().catch(() => undefined);
      }
      // Let postgres.js move every slot into its `connecting` queue, where a
      // cold reserve leaves it permanently.
      await sleep(1_000);
      // An ordinary read now has no slot to run on and postgres.js parks it on
      // `queries` with no timeout: the read never completes and nothing is
      // logged. This is why the branch-op client must be separate from the one
      // that serves reads, and why /readyz probes with its own deadline.
      expect(await outcomeWithin(sql.unsafe("SELECT 1"), 2_000)).toBe(
        "pending"
      );
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("documents the starvation: held reserves exhaust the pool and the next query parks", async () => {
    // This is the half of bug.5386 that PR #2611 left open and bug.5391 closes.
    // A branch op pins its connection for the whole operation — seconds on a
    // loaded Doltgres. Once every slot is pinned, the next caller's query goes
    // onto postgres.js's unbounded backlog with no deadline of its own, so a
    // READ hangs because WRITES are slow. That is why branch work gets its own
    // client and why the acquire deadline must span the priming query.
    const max = 2;
    const sql = client(max);
    const held: Array<{ release: () => void }> = [];
    try {
      for (let i = 0; i < max; i++) {
        await sql.unsafe("SELECT 1");
        held.push(await sql.reserve());
      }
      expect(await outcomeWithin(sql.unsafe("SELECT 1"), 2_000)).toBe(
        "pending"
      );
    } finally {
      for (const conn of held) conn.release();
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("serializes a burst instead of starving the pool", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql);
    try {
      let concurrent = 0;
      let peak = 0;
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 6 }, (_unused, i) =>
          runner.run(`op-${i}`, async (conn) => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            order.push(i);
            await conn.unsafe("SELECT 1");
            await sleep(5);
            concurrent -= 1;
          })
        )
      );
      expect(peak).toBe(1);
      expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("keeps serving after an operation throws", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql);
    try {
      await expect(
        runner.run("boom", async () => {
          throw new Error("operation failed");
        })
      ).rejects.toThrow("operation failed");
      // A failed operation must release its queue ticket and its connection, or
      // the very next write inherits the failure.
      await expect(
        runner.run("after", async (conn) => {
          await conn.unsafe("SELECT 1");
          return "ok";
        })
      ).resolves.toBe("ok");
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("fails loud with a retryable busy error when the queue backs up", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql, { queueWaitMs: 100 });
    try {
      let releaseHolder: () => void = () => undefined;
      const holder = runner.run("holder", async () => {
        await new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
      });
      await expect(runner.run("queued", async () => undefined)).rejects.toThrow(
        KnowledgeBusyError
      );
      releaseHolder();
      await holder;
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("rebuilds a wedged client rather than leaving a slot burnt", async () => {
    // Every slot pre-burnt by bare cold reserves: reserve can never be served.
    const create = () => {
      const sql = client(1);
      void sql.reserve().catch(() => undefined);
      return sql;
    };
    const first = create();
    const runner = new DoltBranchSessionRunner(first, {
      acquireTimeoutMs: 300,
      recreateClient: create,
    });
    try {
      await expect(runner.run("wedged", async () => undefined)).rejects.toThrow(
        KnowledgeBusyError
      );
      // The condemned pool is replaced, so the next caller does not inherit it.
      await sleep(200);
      expect(runner.client).not.toBe(first);
    } finally {
      void runner.client.end({ timeout: 0 }).catch(() => undefined);
      void first.end({ timeout: 0 }).catch(() => undefined);
    }
  });
});
