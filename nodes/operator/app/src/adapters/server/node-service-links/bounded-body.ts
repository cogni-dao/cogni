// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/bounded-body`
 * Purpose: Read an HTTP response body with a real byte cap (story.0038).
 * Scope: Content-length refusal plus a streamed read with a byte counter that stops at the cap. Does not parse the body.
 * Invariants:
 *   - CAP_IS_ENFORCED_WHILE_READING: a declared content-length above the cap is refused without reading; otherwise the
 *     stream is read chunk by chunk and cancelled the moment the counter passes the cap, so an oversized or endless body
 *     never sits in memory.
 *   - CALLER_CATCHES_STREAM_ERRORS: a mid-body failure rejects; callers read inside their own try.
 * Side-effects: IO (consumes the response body)
 * Links: node-host-transport.ts, enrollment-transport.adapter.ts
 * @internal
 */

export type BoundedBody =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: "too_large" };

export async function readBoundedBody(
  response: Response,
  maxBytes: number
): Promise<BoundedBody> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }
  if (!response.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}
