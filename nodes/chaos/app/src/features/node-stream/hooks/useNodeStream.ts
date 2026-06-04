// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/hooks/useNodeStream`
 * Purpose: SSE consumer hook for real-time node-level event streams via EventSource.
 * Scope: Connects to /api/v1/node/stream, manages latest-by-type map. Does not filter or transform events.
 * Invariants:
 *   - SSE_RESUME_SAFE: EventSource natively passes Last-Event-ID on reconnect
 *   - NO_PROVIDER_WRAPPER: Standalone hook, no React Context
 * Side-effects: IO (EventSource SSE connection)
 * Links: docs/spec/data-streams.md, @cogni/node-streams
 * @public
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal event shape matching NodeEventBase from @cogni/node-streams. */
export interface StreamEvent {
  type: string;
  timestamp: string;
  source: string;
  [key: string]: unknown;
}

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface UseNodeStreamResult {
  /** SSE connection state. */
  status: ConnectionStatus;
  /** Latest event per type — O(1) lookup. */
  latest: ReadonlyMap<string, StreamEvent>;
  /** All events in reception order (most recent last), capped at bufferSize. */
  events: readonly StreamEvent[];
}

const SSE_URL = "/api/v1/node/stream";

/**
 * Subscribe to the node's real-time event stream via SSE.
 *
 * Uses the native EventSource API which handles reconnection and
 * Last-Event-ID automatically.
 */
export function useNodeStream(opts?: {
  enabled?: boolean;
  bufferSize?: number;
}): UseNodeStreamResult {
  const { enabled = true, bufferSize = 50 } = opts ?? {};

  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [latest, setLatest] = useState<ReadonlyMap<string, StreamEvent>>(
    () => new Map()
  );
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);

  // Refs to avoid stale closures in EventSource callbacks
  const bufferRef = useRef<StreamEvent[]>([]);
  const latestRef = useRef<Map<string, StreamEvent>>(new Map());
  const bufferSizeRef = useRef(bufferSize);
  bufferSizeRef.current = bufferSize;

  const handleEvent = useCallback((messageEvent: MessageEvent<string>) => {
    try {
      const event = JSON.parse(messageEvent.data) as StreamEvent;
      if (!event.type || !event.timestamp) return;

      // Update latest-by-type map
      latestRef.current = new Map(latestRef.current);
      latestRef.current.set(event.type, event);
      setLatest(latestRef.current);

      // Update ring buffer
      const buf = [...bufferRef.current, event];
      if (buf.length > bufferSizeRef.current) {
        buf.splice(0, buf.length - bufferSizeRef.current);
      }
      bufferRef.current = buf;
      setEvents(buf);
    } catch {
      // Malformed SSE data — skip silently
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    const es = new EventSource(SSE_URL);

    // EventSource fires typed events matching the `event:` field in SSE.
    // Our SSE format uses `event: health`, `event: ci_status`, etc.
    // We listen on "message" (default) as a fallback, plus known types.
    const knownTypes = [
      "health",
      "ci_status",
      "deploy",
      "snapshot",
      "process_health",
    ] as const;

    for (const type of knownTypes) {
      es.addEventListener(type, handleEvent);
    }
    // Also catch any untyped events
    es.addEventListener("message", handleEvent);

    es.onopen = () => setStatus("open");
    es.onerror = () => {
      // EventSource auto-reconnects. Mark as connecting (not error)
      // unless the connection is permanently closed.
      if (es.readyState === EventSource.CLOSED) {
        setStatus("error");
      } else {
        setStatus("connecting");
      }
    };

    return () => {
      es.close();
      setStatus("closed");
    };
  }, [enabled, handleEvent]);

  return { status, latest, events };
}
