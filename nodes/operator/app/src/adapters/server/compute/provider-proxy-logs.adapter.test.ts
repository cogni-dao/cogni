// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  decodeFrameMessage,
  decodeProxyFrame,
  ProviderProxyLogsClient,
  parseLeaseLogWindow,
} from "./provider-proxy-logs.adapter";

/** Minimal scripted stand-in for the Node 22 global WebSocket. */
class FakeWebSocket {
  static lastInstance: FakeWebSocket | undefined;
  readonly url: string;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: never) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.lastInstance = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, fn: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event as never);
    }
  }
}

function client(overrides?: { idleMs?: number; hardCapMs?: number }) {
  return new ProviderProxyLogsClient({
    proxyUrl: "https://console.akash.network/provider-proxy-mainnet",
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    idleMs: overrides?.idleMs ?? 50,
    hardCapMs: overrides?.hardCapMs ?? 500,
  });
}

const READ_INPUT = {
  providerHostUri: "https://provider.zencloud.eu:8443",
  providerAccount: "akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm",
  dseq: "7001",
  gseq: 1,
  oseq: 1,
  token: "jwt-logs",
  tail: 50,
} as const;

/** Relay a provider log line the way the proxy does (Buffer JSON-serialized). */
function relayFrame(line: string): string {
  return JSON.stringify({
    type: "websocket",
    message: JSON.parse(JSON.stringify(Buffer.from(line, "utf8"))),
  });
}

describe("ProviderProxyLogsClient (websocket relay)", () => {
  it("sends the proxy frame (https url kept, jwt auth) and parses relayed lines until closed", async () => {
    const reader = client();
    const promise = reader.read(READ_INPUT);
    await new Promise((r) => setTimeout(r, 0));

    const socket = FakeWebSocket.lastInstance;
    if (!socket) throw new Error("socket not constructed");
    expect(socket.url).toBe(
      "wss://console.akash.network/provider-proxy-mainnet"
    );
    const sent = JSON.parse(socket.sent[0] ?? "{}");
    expect(sent).toMatchObject({
      type: "websocket",
      url: "https://provider.zencloud.eu:8443/lease/7001/1/1/logs?follow=false&tail=50",
      providerAddress: READ_INPUT.providerAccount,
      auth: { type: "jwt", token: "jwt-logs" },
    });

    socket.emit("message", {
      data: relayFrame('{"name":"app-abc-x","message":"hello"}'),
    });
    socket.emit("message", {
      data: relayFrame('{"name":"paper-trader-d-y","message":"world"}'),
    });
    socket.emit("message", {
      data: JSON.stringify({ type: "websocket", message: "", closed: true }),
    });

    const lines = await promise;
    expect(lines).toEqual([
      { name: "app-abc-x", message: "hello" },
      { name: "paper-trader-d-y", message: "world" },
    ]);
    expect(socket.closed).toBe(true);
  });

  it("rejects when the relay reports an error and no data arrived", async () => {
    const reader = client();
    const promise = reader.read(READ_INPUT);
    await new Promise((r) => setTimeout(r, 0));
    const socket = FakeWebSocket.lastInstance;
    if (!socket) throw new Error("socket not constructed");

    socket.emit("message", {
      data: JSON.stringify({
        type: "websocket",
        message: "Received error from provider websocket",
        error: "Received error from provider websocket",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({ type: "websocket", message: "", closed: true }),
    });

    await expect(promise).rejects.toThrow(/relay error/);
  });

  it("resolves what it has on idle timeout (proxy never says closed)", async () => {
    const reader = client({ idleMs: 20 });
    const promise = reader.read(READ_INPUT);
    await new Promise((r) => setTimeout(r, 0));
    const socket = FakeWebSocket.lastInstance;
    if (!socket) throw new Error("socket not constructed");

    socket.emit("message", {
      data: relayFrame('{"name":"app-abc-x","message":"only line"}'),
    });
    const lines = await promise;
    expect(lines).toEqual([{ name: "app-abc-x", message: "only line" }]);
  });
});

describe("frame decoding", () => {
  it("decodes JSON frames and passes raw strings through", () => {
    expect(decodeProxyFrame('{"closed":true}')).toEqual({ closed: true });
    expect(decodeProxyFrame("not json")).toEqual({
      type: "websocket",
      message: "not json",
    });
    expect(decodeProxyFrame(123)).toBeUndefined();
  });

  it("decodes serialized Buffers and plain strings", () => {
    const serialized = JSON.parse(JSON.stringify(Buffer.from("abc", "utf8")));
    expect(decodeFrameMessage(serialized)).toBe("abc");
    expect(decodeFrameMessage("xyz")).toBe("xyz");
    expect(decodeFrameMessage(undefined)).toBe("");
  });
});

describe("parseLeaseLogWindow", () => {
  it("parses NDJSON and preserves malformed rows under the fallback name", () => {
    const parsed = parseLeaseLogWindow(
      '{"name":"app-1","message":"ok"}\nplain text row\n\n',
      "dseq-7001"
    );
    expect(parsed).toEqual([
      { name: "app-1", message: "ok" },
      { name: "dseq-7001", message: "plain text row" },
    ]);
  });
});
