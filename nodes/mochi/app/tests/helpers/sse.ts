// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/helpers/sse`
 * Purpose: Server-Sent Events (SSE) parsing utilities for testing streaming endpoints.
 * Scope: Provides utilities to parse SSE event streams in tests. Does not contain test assertions.
 * Invariants: Yields parsed events incrementally as they arrive; handles blank lines and data fields
 * Side-effects: IO (reads from ReadableStream)
 * Notes: Use for stack tests that need to consume and validate SSE streaming responses.
 * Links: tests/stack/ai/chat-streaming.stack.test.ts
 * @public
 */

/**
 * Parsed SSE event structure
 */
export interface SseEvent {
  /** Event type (defaults to 'message' if not specified) */
  event: string;
  /** Event data payload */
  data: string;
}

/**
 * Asynchronously reads and parses Server-Sent Events (SSE) from a Response body stream.
 *
 * SSE format:
 * - Events are separated by blank lines (\n\n)
 * - Each event can have:
 *   - `event: <type>` line (optional, defaults to 'message')
 *   - `data: <payload>` line (can be multiple, joined by \n)
 *   - `: comment` lines (ignored)
 *
 * @param res - Response object with a readable body stream
 * @yields {SseEvent} Parsed SSE events as they arrive
 * @throws {Error} If response body is not readable
 *
 * @example
 * ```ts
 * const response = await fetch('/api/stream');
 * for await (const event of readSseEvents(response)) {
 *   if (event.event === 'message.delta') {
 *     console.log('Delta:', event.data);
 *   }
 * }
 * ```
 */
export async function* readSseEvents(res: Response): AsyncIterable<SseEvent> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body reader");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Normalize \r\n to \n in the incoming chunk only (avoids O(n) work on entire buffer)
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk.replace(/\r\n/g, "\n");

      // SSE events are separated by blank lines (\n\n)
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        // Skip empty events (multiple blank lines)
        if (raw.trim().length === 0) continue;

        // Parse event and data lines
        let event = "message"; // Default event type
        const dataLines: string[] = [];

        for (const line of raw.split("\n")) {
          if (line.startsWith(":")) {
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            // SSE spec: "data: " has optional space after colon that should be stripped
            // Use slice(5) to get everything after "data:", then strip only leading space if present
            const dataValue = line.slice(5);
            dataLines.push(
              dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue
            );
          }
          // Other field types (id, retry) are ignored for this MVP
        }

        const data = dataLines.join("\n");

        // Yield the parsed event
        yield { event, data };
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
