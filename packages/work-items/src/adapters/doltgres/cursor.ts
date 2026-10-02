// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/adapters/doltgres/cursor`
 * Purpose: Opaque cursor encode/decode for keyset pagination of work_items.
 * Scope: Pure helpers encoding the composite sort key (priority, rank, createdAt, id) as base64url(JSON). Does not perform IO or SQL.
 * Invariants:
 *   - OPAQUE_TO_CLIENTS: clients must treat cursor as a black box.
 *   - STABLE_TIEBREAK: id is the unique tiebreaker so progression is deterministic
 *     even when many rows share createdAt (importer batch wrote ~462 in one tick).
 * Side-effects: none
 * Links: bug.5162, docs/spec/work-items-port.md
 * @internal
 */

export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export type WorkItemCursor = {
  /** priority (null becomes 999 in sort key — encoded as null here) */
  p: number | null;
  /** rank (null becomes 999 in sort key — encoded as null here) */
  r: number | null;
  /** createdAt ISO string */
  ts: string;
  /** row id (e.g. "task.5042") */
  id: string;
};

function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

export function encodeCursor(c: WorkItemCursor): string {
  return base64UrlEncode(JSON.stringify(c));
}

export function decodeCursor(raw: string): WorkItemCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("ts" in parsed) ||
    !("id" in parsed) ||
    !("p" in parsed) ||
    !("r" in parsed)
  ) {
    throw new InvalidCursorError();
  }
  const obj = parsed as Record<string, unknown>;
  const p = obj.p === null ? null : Number(obj.p);
  const r = obj.r === null ? null : Number(obj.r);
  if (p !== null && !Number.isFinite(p)) throw new InvalidCursorError();
  if (r !== null && !Number.isFinite(r)) throw new InvalidCursorError();
  return {
    p,
    r,
    ts: String(obj.ts),
    id: String(obj.id),
  };
}
