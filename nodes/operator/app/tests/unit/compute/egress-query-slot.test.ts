import { execFile } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressQuerySlot } from "@/adapters/server/compute/egress-query-slot";

afterEach(() => vi.useRealTimers());
describe("one original PendingQuery owns the feature slot", () => {
  it("does not submit while busy and retains ownership after deadline until original settlement", async () => {
    vi.useFakeTimers();
    let settle!: (value: postgres.RowList<postgres.Row[]>) => void;
    const original = new Promise<postgres.RowList<postgres.Row[]>>(
      (resolve) => {
        settle = resolve;
      }
    );
    const cancel = vi.fn();
    // A lifecycle double only: real driver cancellation is covered separately below.
    const query = Object.assign(original, { cancel }) as postgres.PendingQuery<
      postgres.Row[]
    >;
    const slot = new EgressQuerySlot();
    const first = slot.run(() => query);
    const failure = expect(first).rejects.toThrow("egress_query_deadline");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
    const create = vi.fn(() => query);
    await expect(slot.run(create)).rejects.toThrow("egress_query_busy");
    expect(create).not.toHaveBeenCalled();
    settle([] as unknown as postgres.RowList<postgres.Row[]>);
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.busy).toBe(false);
    slot.stop();
    await expect(slot.run(create)).rejects.toThrow("egress_query_stopped");
  });
  it("cancels a real lazy postgres PendingQuery before assignment without connecting", async () => {
    const sql = postgres("postgres://unused@127.0.0.1:1/unused", {
      max: 1,
      connect_timeout: 1,
    });
    try {
      const query = sql`select 1`;
      const slot = new EgressQuerySlot();
      const result = slot.run(() => query);
      const rejected = expect(result).rejects.toThrow();
      slot.stop();
      await rejected;
      await Promise.resolve();
      expect(slot.busy).toBe(false);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

// Real postgres 3.4.7 client against a finite wire peer. This proves driver ownership,
// NOT Postgres SQL semantics; migration/lock/write-deadline need real-DB CI proof.
async function wirePeer() {
  const sockets = new Set<Socket>();
  let original: Socket | undefined;
  let start!: () => void;
  let canceled!: () => void;
  const executing = new Promise<void>((resolve) => {
    start = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  function packet(type: string, body = Buffer.alloc(0)) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(body.length + 4);
    return Buffer.concat([Buffer.from(type), size, body]);
  }
  const ready = () => packet("Z", Buffer.from("I"));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let startup = true;
    let pending = Buffer.alloc(0);
    let running = false;
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      if (startup) {
        if (pending.length < 8) return;
        const length = pending.readInt32BE(0);
        if (pending.length < length) return;
        if (pending.readInt32BE(4) === 80877102) {
          canceled();
          socket.end();
          return;
        }
        pending = pending.subarray(length);
        startup = false;
        original = socket;
        const key = Buffer.alloc(8);
        key.writeInt32BE(123, 0);
        key.writeInt32BE(456, 4);
        socket.write(
          Buffer.concat([
            packet("R", Buffer.alloc(4)),
            packet("K", key),
            ready(),
          ])
        );
      }
      while (pending.length >= 5) {
        const size = pending.readInt32BE(1);
        if (pending.length < size + 1) return;
        const kind = String.fromCharCode(pending.readUInt8(0));
        pending = pending.subarray(size + 1);
        if (kind === "P") socket.write(packet("1"));
        if (kind === "D")
          socket.write(
            Buffer.concat([packet("t", Buffer.alloc(2)), packet("n")])
          );
        if (kind === "B") socket.write(packet("2"));
        if (kind === "E") {
          running = true;
          start();
        }
        if (kind === "S" && !running) socket.write(ready());
        if (kind === "X") socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("wire_peer_address");
  const sql = postgres({
    host: "127.0.0.1",
    port: address.port,
    username: "fixture",
    database: "fixture",
    ssl: false,
    fetch_types: false,
    max: 1,
    connect_timeout: 1,
  });
  return {
    sql,
    executing,
    cancellation,
    settle: () =>
      original?.write(
        Buffer.concat([
          packet("E", Buffer.from("SERROR\0C57014\0Mcancelled\0\0")),
          ready(),
        ])
      ),
    lose: () => original?.destroy(),
    close: async () => {
      await sql.end({ timeout: 0 });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("retains the slot through real prepare/describe/assignment and cancel transport until original error", async () => {
  const peer = await wirePeer();
  try {
    const slot = new EgressQuerySlot();
    const operation = slot.run(() => peer.sql`select 1`);
    const rejected = expect(operation).rejects.toThrow("egress_query_deadline");
    await peer.executing;
    await peer.cancellation;
    await rejected;
    expect(slot.busy).toBe(true);
    await expect(slot.run(() => peer.sql`select 2`)).rejects.toThrow(
      "egress_query_busy"
    );
    peer.settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.busy).toBe(false);
  } finally {
    await peer.close();
  }
});

it("keeps ownership after cancellation acknowledgement until original connection loss settles", async () => {
  const peer = await wirePeer();
  try {
    const slot = new EgressQuerySlot();
    const operation = slot.run(() => peer.sql`select 1`);
    const rejected = expect(operation).rejects.toThrow("egress_query_deadline");
    await peer.executing;
    await peer.cancellation;
    await rejected;
    expect(slot.busy).toBe(true);
    peer.lose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.busy).toBe(false);
  } finally {
    await peer.close();
  }
});

it("removes a real queued query without assigning it while an unrelated original owns the only connection", async () => {
  const peer = await wirePeer();
  try {
    const first = peer.sql`select 1`;
    const firstSettled = first.then(
      () => undefined,
      () => undefined
    );
    await peer.executing;
    const slot = new EgressQuerySlot();
    await expect(slot.run(() => peer.sql`select 2`)).rejects.toThrow(
      "egress_query_deadline"
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.busy).toBe(false); // Real driver removed its unassigned query.
    peer.settle();
    await firstSettled;
  } finally {
    await peer.close();
  }
});

it("retains accounting when cancel throws; a late success cannot convert deadline into acceptance", async () => {
  vi.useFakeTimers();
  let settle!: (value: postgres.RowList<postgres.Row[]>) => void;
  const original = new Promise<postgres.RowList<postgres.Row[]>>((resolve) => {
    settle = resolve;
  });
  const query = Object.assign(original, {
    cancel: () => {
      throw new Error("transport_failure");
    },
  }) as postgres.PendingQuery<postgres.Row[]>;
  const slot = new EgressQuerySlot();
  const operation = slot.run(() => query);
  const rejection = expect(operation).rejects.toThrow("egress_query_deadline");
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(slot.busy).toBe(true);
  settle([] as unknown as postgres.RowList<postgres.Row[]>);
  await vi.runAllTimersAsync();
  expect(slot.busy).toBe(false);
  await expect(operation).rejects.toThrow("egress_query_deadline");
});

it("falsifies failed real cancel transport in an isolated process and retains the original slot", async () => {
  const fixture = fileURLToPath(
    new URL("./egress-cancel-transport.fixture.mjs", import.meta.url)
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", fixture],
    { timeout: 3000, maxBuffer: 4096 }
  );
  expect(JSON.parse(stdout)).toEqual({
    result: "egress_query_deadline",
    cancelTransportRejected: true,
    heldAfterFailedCancel: true,
    releasedAfterOriginalLoss: true,
  });
});
