// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-core/run-stream`
 * Purpose: Streaming transport for graph run events (publish/subscribe via append-log).
 * Scope: Port interface for ephemeral event streaming between Temporal activities and SSE endpoints. Does not implement streaming logic.
 * Invariants:
 *   - REDIS_IS_STREAM_PLANE: Only ephemeral stream data, not durable state
 *   - PUMP_TO_COMPLETION_VIA_REDIS: Publisher pumps all events regardless of subscriber count
 *   - SSE_FROM_REDIS_NOT_MEMORY: Subscribers read from stream, not in-process memory
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/graph-run-launch-contract §7-10
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";

/** Redis stream key prefix for run events. */
export const RUN_STREAM_KEY_PREFIX = "run:";

/** Default MAXLEN for XADD (approximate trim). */
export const RUN_STREAM_MAXLEN = 10_000;

/** Default block timeout in ms for XREAD. */
export const RUN_STREAM_BLOCK_MS = 5_000;

/** Default TTL in seconds for stream expiry after terminal event. */
export const RUN_STREAM_DEFAULT_TTL_SECONDS = 3_600;

/** A single entry in a run's event stream. */
export interface RunStreamEntry {
  /** Stream entry ID (Redis stream ID, e.g. "1710000000000-0"). */
  id: string;
  /** The event payload. */
  event: AiEvent;
}

/**
 * Port for publishing and subscribing to real-time graph run event streams.
 *
 * Publishers (Temporal activities) append events via `publish()`.
 * Subscribers (SSE endpoints) consume events via `subscribe()` with cursor-based replay.
 */
export interface RunStreamPort {
  /** Publish a single event to the run's stream. */
  publish(runId: string, event: AiEvent): Promise<void>;

  /**
   * Subscribe to a run's stream from a cursor position.
   *
   * Yields `RunStreamEntry` pairs. Terminates on done/error events.
   * If `fromId` is provided, replays from that position first (catch-up),
   * then switches to live reads (block-wait).
   *
   * @param runId - The run identifier
   * @param signal - AbortSignal for cancellation
   * @param fromId - Optional cursor to replay from (exclusive)
   */
  subscribe(
    runId: string,
    signal: AbortSignal,
    fromId?: string
  ): AsyncIterable<RunStreamEntry>;

  /** Set TTL on a run's stream (call after terminal event for auto-cleanup). */
  expire(runId: string, ttlSeconds: number): Promise<void>;

  /** Returns the number of entries in a run's stream (0 if key doesn't exist). */
  streamLength(runId: string): Promise<number>;
}
