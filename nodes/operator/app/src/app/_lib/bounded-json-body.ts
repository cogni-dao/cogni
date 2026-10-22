// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/bounded-json-body`
 * Purpose: Bound unauthenticated JSON request bodies before credential or backend IO.
 * Scope: Web Request streams only; syntax validation, not domain-schema validation.
 * Invariants: HARD_BYTE_LIMIT; CANCEL_ON_OVERFLOW; NO_UNBOUNDED_ARRAY_BUFFER.
 * Side-effects: consumes and may cancel the request body stream.
 * Links: task.5226
 * @internal
 */

export type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid_json" | "too_large" };

export async function readBoundedJson(
  request: Request,
  maxBytes: number
): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    return { ok: false, reason: "too_large" };
  }

  if (request.body === null) {
    return { ok: false, reason: "invalid_json" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(body)) as unknown,
    };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
