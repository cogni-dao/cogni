// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/redis-run-stream.adapter`
 * Purpose: Unit tests for RedisRunStreamAdapter with mocked ioredis.
 * Scope: Tests publish (XADD), subscribe (XRANGE replay + XREAD live), expire, terminal event handling.
 * Invariants: No real Redis; deterministic mock responses; REDIS_IS_STREAM_PLANE
 * Side-effects: none (mocked Redis)
 * Links: src/adapters/server/ai/redis-run-stream.adapter.ts, RunStreamPort
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RedisRunStreamAdapter } from "@/adapters/server/ai/redis-run-stream.adapter";
import {
  RUN_STREAM_BLOCK_MS,
  RUN_STREAM_KEY_PREFIX,
  RUN_STREAM_MAXLEN,
} from "@/ports";

// -- Mock helpers --

function createMockRedis() {
  const mock = {
    xadd: vi.fn().mockResolvedValue("1-0"),
    xrange: vi.fn().mockResolvedValue([]),
    xread: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(1),
    duplicate: vi.fn(),
    disconnect: vi.fn(),
  };
  // duplicate() returns a new mock with same shape for blocking reads
  const blockMock = {
    xread: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn(),
  };
  mock.duplicate.mockReturnValue(blockMock);
  return { mock, blockMock };
}

function makeEvent(type: string, extra?: Record<string, unknown>): AiEvent {
  return { type, ...extra } as unknown as AiEvent;
}

function encodeEntry(id: string, event: AiEvent): [string, string[]] {
  return [id, ["data", JSON.stringify(event)]];
}

async function collectAsync<T>(
  iter: AsyncIterable<T>,
  max = 100
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

// -- Tests --

describe("RedisRunStreamAdapter", () => {
  const runId = "test-run-123";
  const expectedKey = `${RUN_STREAM_KEY_PREFIX}${runId}`;
  let redisMock: ReturnType<typeof createMockRedis>["mock"];
  let blockMock: ReturnType<typeof createMockRedis>["blockMock"];
  let adapter: RedisRunStreamAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockRedis();
    redisMock = mocks.mock;
    blockMock = mocks.blockMock;
    adapter = new RedisRunStreamAdapter(redisMock as never);
  });

  describe("publish", () => {
    it("calls XADD with correct key, MAXLEN, and serialized event", async () => {
      const event = makeEvent("text_delta", { delta: "hello" });

      await adapter.publish(runId, event);

      expect(redisMock.xadd).toHaveBeenCalledWith(
        expectedKey,
        "MAXLEN",
        "~",
        String(RUN_STREAM_MAXLEN),
        "*",
        "data",
        JSON.stringify(event)
      );
    });
  });

  describe("subscribe", () => {
    it("yields replayed entries from XRANGE when fromId is provided", async () => {
      const event1 = makeEvent("text_delta", { delta: "a" });
      const event2 = makeEvent("text_delta", { delta: "b" });
      const eventDone = makeEvent("done");

      // XRANGE returns entries including fromId (inclusive) — adapter skips fromId itself
      redisMock.xrange.mockResolvedValue([
        encodeEntry("1-0", event1), // this is fromId, should be skipped
        encodeEntry("2-0", event2),
        encodeEntry("3-0", eventDone),
      ]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      expect(redisMock.xrange).toHaveBeenCalledWith(expectedKey, "1-0", "+");
      expect(entries).toHaveLength(2);
      expect(entries[0]?.id).toBe("2-0");
      expect(entries[0]?.event).toEqual(event2);
      expect(entries[1]?.id).toBe("3-0");
      expect(entries[1]?.event).toEqual(eventDone);
    });

    it("stops after terminal 'done' event in replay", async () => {
      const eventDone = makeEvent("done");
      const eventAfter = makeEvent("text_delta", { delta: "ignored" });

      redisMock.xrange.mockResolvedValue([
        encodeEntry("2-0", eventDone),
        encodeEntry("3-0", eventAfter),
      ]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      // Should stop at done, never reach XREAD phase
      expect(entries).toHaveLength(1);
      expect(entries[0]?.event.type).toBe("done");
      expect(blockMock.xread).not.toHaveBeenCalled();
    });

    it("stops after terminal 'error' event in replay", async () => {
      const eventError = makeEvent("error", { message: "fail" });

      redisMock.xrange.mockResolvedValue([encodeEntry("2-0", eventError)]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]?.event.type).toBe("error");
    });

    it("enters live XREAD phase after replay and yields new entries", async () => {
      // Empty replay
      redisMock.xrange.mockResolvedValue([]);

      const liveEvent = makeEvent("text_delta", { delta: "live" });
      const doneEvent = makeEvent("done");

      // First XREAD returns a live event, second returns done
      blockMock.xread
        .mockResolvedValueOnce([[expectedKey, [encodeEntry("5-0", liveEvent)]]])
        .mockResolvedValueOnce([
          [expectedKey, [encodeEntry("6-0", doneEvent)]],
        ]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      expect(entries).toHaveLength(2);
      expect(entries[0]?.id).toBe("5-0");
      expect(entries[1]?.event.type).toBe("done");

      // Verify XREAD was called with COUNT before BLOCK
      expect(blockMock.xread).toHaveBeenCalledWith(
        "COUNT",
        100,
        "BLOCK",
        RUN_STREAM_BLOCK_MS,
        "STREAMS",
        expectedKey,
        "1-0"
      );
    });

    it("uses last replayed entry as XREAD cursor (no duplicates)", async () => {
      // Replay returns non-terminal entries after fromId
      redisMock.xrange.mockResolvedValue([
        encodeEntry("1-0", makeEvent("text_delta", { delta: "a" })), // fromId, skipped
        encodeEntry("2-0", makeEvent("text_delta", { delta: "b" })),
        encodeEntry("3-0", makeEvent("text_delta", { delta: "c" })),
      ]);
      const doneEvent = makeEvent("done");
      blockMock.xread.mockResolvedValueOnce([
        [expectedKey, [encodeEntry("4-0", doneEvent)]],
      ]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      expect(entries).toHaveLength(3); // 2 replay + 1 live
      // XREAD cursor must be "3-0" (last replayed), NOT "1-0" (fromId)
      expect(blockMock.xread).toHaveBeenCalledWith(
        "COUNT",
        100,
        "BLOCK",
        RUN_STREAM_BLOCK_MS,
        "STREAMS",
        expectedKey,
        "3-0"
      );
    });

    it("starts from 0-0 when no fromId is provided", async () => {
      const doneEvent = makeEvent("done");

      blockMock.xread.mockResolvedValueOnce([
        [expectedKey, [encodeEntry("1-0", doneEvent)]],
      ]);

      const controller = new AbortController();
      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal)
      );

      expect(entries).toHaveLength(1);
      // Should NOT call xrange (no fromId)
      expect(redisMock.xrange).not.toHaveBeenCalled();
      // XREAD starts from 0-0
      expect(blockMock.xread).toHaveBeenCalledWith(
        "COUNT",
        100,
        "BLOCK",
        RUN_STREAM_BLOCK_MS,
        "STREAMS",
        expectedKey,
        "0-0"
      );
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const entries = await collectAsync(
        adapter.subscribe(runId, controller.signal, "1-0")
      );

      expect(entries).toHaveLength(0);
    });

    it("disconnects the blocking client on completion", async () => {
      redisMock.xrange.mockResolvedValue([]);

      const doneEvent = makeEvent("done");
      blockMock.xread.mockResolvedValueOnce([
        [expectedKey, [encodeEntry("1-0", doneEvent)]],
      ]);

      const controller = new AbortController();
      await collectAsync(adapter.subscribe(runId, controller.signal));

      expect(blockMock.disconnect).toHaveBeenCalled();
    });

    it("throws when stream entry is missing 'data' field", async () => {
      const badEntry: [string, string[]] = ["1-0", ["other", "value"]];
      redisMock.xrange.mockResolvedValue([badEntry]);

      const controller = new AbortController();

      await expect(
        collectAsync(adapter.subscribe(runId, controller.signal, "0-0"))
      ).rejects.toThrow("missing 'data' field");
    });
  });

  describe("expire", () => {
    it("sets TTL on the stream key", async () => {
      await adapter.expire(runId, 3600);

      expect(redisMock.expire).toHaveBeenCalledWith(expectedKey, 3600);
    });
  });
});
