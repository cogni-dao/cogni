// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/reserve-connection`
 * Purpose: Pin the PRIME_BEFORE_RESERVE invariant that keeps the Doltgres knowledge plane from wedging (bug.5386).
 * Scope: Harness-level proof against a fake PG wire server. Does not connect to Doltgres and does not assert application behaviour.
 * Invariants:
 *   - A bare `sql.reserve()` as the first operation on a `fetch_types: false`
 *     client NEVER settles. This is the defect; the first test documents it so
 *     the fix cannot be mistaken for cargo cult.
 *   - `reserveDoltgresConnection` resolves on the same cold pool.
 *   - Once every pool slot has been burned by cold reserves, ordinary reads
 *     hang forever too — the "whole plane wedges, reads included" signature.
 * Side-effects: IO (binds a loopback TCP server on an ephemeral port)
 * Links: packages/knowledge-store/src/adapters/doltgres/build-client.ts
 * @internal
 */

import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDoltgresClient,
  DoltgresReserveTimeoutError,
  reserveDoltgresConnection,
} from "../src/adapters/doltgres/build-client.js";

// ---------------------------------------------------------------------------
// Minimal Postgres wire server: completes startup (trust auth) and answers any
// subsequent client traffic with an empty result set. Enough to drive
// postgres.js's pool state machine, which is the only thing under test.
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

const AUTH_OK = msg("R", int32(0));
const BACKEND_KEY = msg("K", Buffer.concat([int32(1234), int32(5678)]));
const READY_IDLE = msg("Z", Buffer.from("I", "ascii"));
const PARSE_COMPLETE = msg("1", Buffer.alloc(0));
const BIND_COMPLETE = msg("2", Buffer.alloc(0));
const NO_DATA = msg("n", Buffer.alloc(0));
const CMD_COMPLETE = msg("C", Buffer.from("SELECT 0\0", "ascii"));

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

function startFakePostgres(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
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
          socket.write(QUERY_RESPONSE);
        }
      });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake postgres failed to bind an ephemeral port");
      }
      resolve({ server, port: address.port });
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

describe("reserveDoltgresConnection (bug.5386)", () => {
  let server: net.Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startFakePostgres());
  });

  afterAll(async () => {
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

  it("resolves on a cold pool because it primes a connection first", async () => {
    const sql = client();
    try {
      const conn = await reserveDoltgresConnection(sql, { timeoutMs: 5_000 });
      expect(conn).toBeDefined();
      conn.release();
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("is repeatable — successive reserve/release cycles keep working", async () => {
    const sql = client();
    try {
      for (let i = 0; i < 3; i++) {
        const conn = await reserveDoltgresConnection(sql, { timeoutMs: 5_000 });
        await conn.unsafe("SELECT 1");
        conn.release();
      }
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("fails loud instead of hanging when the pool cannot hand over a connection", async () => {
    const sql = client(1);
    try {
      // Hold the single pool slot, so the next reserve can never be served.
      const held = await reserveDoltgresConnection(sql, { timeoutMs: 5_000 });
      await expect(
        reserveDoltgresConnection(sql, { timeoutMs: 250 })
      ).rejects.toBeInstanceOf(DoltgresReserveTimeoutError);
      held.release();
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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // An ordinary read now has no slot to run on and postgres.js parks it on
      // `queries` with no timeout: the read never completes and nothing is
      // logged. This is why /readyz must probe the knowledge store with its own
      // bounded timeout rather than awaiting a query that cannot return.
      expect(await outcomeWithin(sql.unsafe("SELECT 1"), 2_000)).toBe(
        "pending"
      );
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });
});
