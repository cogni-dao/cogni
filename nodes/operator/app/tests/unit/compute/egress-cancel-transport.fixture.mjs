// Isolated driver falsifier. The rejection listener is TEST ONLY, never runtime policy.
import { createServer } from "node:net";
import postgres from "postgres";
import slotModule from "../../../src/adapters/server/compute/egress-query-slot.ts";

const { EgressQuerySlot } = slotModule;
const packet = (type, body = Buffer.alloc(0)) => {
  const size = Buffer.alloc(4);
  size.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), size, body]);
};
let original;
let runningResolve;
const running = new Promise((resolve) => {
  runningResolve = resolve;
});
const server = createServer((socket) => {
  original = socket;
  let startup = true;
  let pending = Buffer.alloc(0);
  socket.on("data", (data) => {
    pending = Buffer.concat([pending, data]);
    if (startup) {
      if (pending.length < 8 || pending.length < pending.readInt32BE(0)) return;
      pending = pending.subarray(pending.readInt32BE(0));
      startup = false;
      const key = Buffer.alloc(8);
      key.writeInt32BE(123);
      key.writeInt32BE(456, 4);
      socket.write(
        Buffer.concat([
          packet("R", Buffer.alloc(4)),
          packet("K", key),
          packet("Z", Buffer.from("I")),
        ])
      );
    }
    while (
      pending.length >= 5 &&
      pending.length >= pending.readInt32BE(1) + 1
    ) {
      const kind = String.fromCharCode(pending.readUInt8(0));
      pending = pending.subarray(pending.readInt32BE(1) + 1);
      if (kind === "P") socket.write(packet("1"));
      if (kind === "D")
        socket.write(
          Buffer.concat([packet("t", Buffer.alloc(2)), packet("n")])
        );
      if (kind === "B") socket.write(packet("2"));
      if (kind === "E") runningResolve();
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const sql = postgres({
  host: "127.0.0.1",
  port: server.address().port,
  username: "fixture",
  database: "fixture",
  ssl: false,
  fetch_types: false,
  max: 1,
  connect_timeout: 1,
});
const slot = new EgressQuerySlot();
let cancelTransportRejected = false;
process.on("unhandledRejection", () => {
  cancelTransportRejected = true;
});
const operation = slot.run(() => sql`select 1`).catch((error) => error.message);
await running;
// Close ONLY the listening socket. Original query transport stays open and unsettled.
server.close();
const result = await operation;
await new Promise((resolve) => setTimeout(resolve, 25));
const heldAfterFailedCancel = slot.busy;
original.destroy();
await new Promise((resolve) => setTimeout(resolve, 25));
await sql.end({ timeout: 0 });
process.stdout.write(
  JSON.stringify({
    result,
    cancelTransportRejected,
    heldAfterFailedCancel,
    releasedAfterOriginalLoss: !slot.busy,
  })
);
