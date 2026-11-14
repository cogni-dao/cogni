// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core/helpers`
 * Purpose: Pure helper functions for deterministic event IDs and canonical payload hashing.
 * Scope: Zero deps beyond Web Crypto (globalThis.crypto). Platform-neutral. Does not perform network I/O or access databases.
 * Invariants:
 * - buildEventId() output is deterministic for the same inputs.
 * - canonicalJson() produces identical output regardless of input key order.
 * - hashCanonicalPayload() produces identical SHA-256 for identical canonical fields.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger (ACTIVITY_IDEMPOTENT, PROVENANCE_REQUIRED)
 * @public
 */

/**
 * Build a deterministic event ID from source, type, and scope parts.
 *
 * @example
 * buildEventId("github", "pr", "owner/repo", 42)
 * // => "github:pr:owner/repo:42"
 *
 * buildEventId("github", "review", "owner/repo", 42, 1234567)
 * // => "github:review:owner/repo:42:1234567"
 *
 * buildEventId("discord", "message", "guild123", "channel456", "msg789")
 * // => "discord:message:guild123:channel456:msg789"
 */
export function buildEventId(
  source: string,
  type: string,
  ...parts: (string | number)[]
): string {
  return `${source}:${type}:${parts.join(":")}`;
}

/**
 * Produce canonical JSON with sorted keys for deterministic serialization.
 * Only sorts top-level keys — nested objects are serialized as-is.
 *
 * @example
 * canonicalJson({ b: 2, a: 1 })
 * // => '{"a":1,"b":2}'
 */
export function canonicalJson(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  return JSON.stringify(obj, sortedKeys);
}

/**
 * SHA-256 hash of canonical payload fields via Web Crypto.
 * Returns lowercase hex string (64 chars).
 *
 * @example
 * await hashCanonicalPayload({ id: "github:pr:owner/repo:42", authorId: "12345", mergedAt: "2026-01-15T00:00:00Z" })
 * // => "a1b2c3d4..."  (deterministic for same input)
 */
export async function hashCanonicalPayload(
  canonicalFields: Record<string, unknown>
): Promise<string> {
  const json = canonicalJson(canonicalFields);
  const data = new TextEncoder().encode(json);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
