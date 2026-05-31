// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/redis-run-stream.adapter`
 * Purpose: Redis Streams implementation of RunStreamPort for ephemeral event streaming.
 * Scope: Publishes AiEvents via XADD, subscribes via XRANGE+XREAD with cursor-based replay.
 * Invariants:
 *   - REDIS_IS_STREAM_PLANE: Only ephemeral stream data, not durable state
 *   - PUMP_TO_COMPLETION_VIA_REDIS: Publisher pumps all events regardless of subscriber count
 *   - SSE_FROM_REDIS_NOT_MEMORY: Subscribers read from Redis Streams, not in-process memory
 * Side-effects: Redis I/O
 * Links: docs/spec/unified-graph-launch.md §7-10
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import type Redis from "ioredis";

import {
  RUN_STREAM_BLOCK_MS,
  RUN_STREAM_KEY_PREFIX,
  RUN_STREAM_MAXLEN,
  type RunStreamEntry,
  type RunStreamPort,
} from "@/ports";

/** Terminal event types that signal stream completion. */
const TERMINAL_EVENT_TYPES = new Set<string>(["done", "error"]);

function streamKey(runId: string): string {
  return `${RUN_STREAM_KEY_PREFIX}${runId}`;
}

/**
 * Parse a Redis stream entry [id, fields[]] into a RunStreamEntry.
 * Fields are flat arrays: ["data", "{json}", ...].
 */
function parseEntry(raw: [string, string[]]): RunStreamEntry {
  const [id, fields] = raw;
  // Fields is a flat array of key-value pairs: [key1, val1, key2, val2, ...]
  let data: string | undefined;
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === "data") {
      data = fields[i + 1];
      break;
    }
  }
  if (!data) {
    throw new Error(`Stream entry ${id} missing 'data' field`);
  }
  return { id, event: JSON.parse(data) as AiEvent };
}

export class RedisRunStreamAdapter implements RunStreamPort {
  constructor(private readonly redis: Redis) {}

  async publish(runId: string, event: AiEvent): Promise<void> {
    const key = streamKey(runId);
    const data = JSON.stringify(event);
    await this.redis.xadd(
      key,
      "MAXLEN",
      "~",
      String(RUN_STREAM_MAXLEN),
      "*",
      "data",
      data
    );
  }

  async *subscribe(
    runId: string,
    signal: AbortSignal,
    fromId?: string
  ): AsyncIterable<RunStreamEntry> {
    const key = streamKey(runId);

    // Phase 1: Replay — catch up from cursor via XRANGE
    // Track last yielded ID so Phase 2 XREAD starts after the last replayed entry.
    let cursor = fromId ?? "0-0";

    if (fromId) {
      const replayEntries = await this.redis.xrange(key, fromId, "+");
      for (const raw of replayEntries) {
        if (signal.aborted) return;
        // Skip the fromId entry itself (XRANGE is inclusive)
        if (raw[0] === fromId) continue;
        const entry = parseEntry(raw);
        cursor = entry.id;
        yield entry;
        if (TERMINAL_EVENT_TYPES.has(entry.event.type)) return;
      }
    }

    // Phase 2: Live reads — block-wait for new events via XREAD
    // Use a dedicated client for blocking reads to avoid blocking the shared connection.
    const blockClient = this.redis.duplicate();
    try {
      while (!signal.aborted) {
        const result = await blockClient.xread(
          "COUNT",
          100,
          "BLOCK",
          RUN_STREAM_BLOCK_MS,
          "STREAMS",
          key,
          cursor
        );

        if (signal.aborted) return;
        if (!result) continue; // timeout, retry

        for (const [, entries] of result) {
          for (const raw of entries) {
            if (signal.aborted) return;
            const entry = parseEntry(raw);
            cursor = entry.id;
            yield entry;
            if (TERMINAL_EVENT_TYPES.has(entry.event.type)) return;
          }
        }
      }
    } finally {
      blockClient.disconnect();
    }
  }

  async expire(runId: string, ttlSeconds: number): Promise<void> {
    const key = streamKey(runId);
    await this.redis.expire(key, ttlSeconds);
  }

  async streamLength(runId: string): Promise<number> {
    const key = streamKey(runId);
    return this.redis.xlen(key);
  }
}
