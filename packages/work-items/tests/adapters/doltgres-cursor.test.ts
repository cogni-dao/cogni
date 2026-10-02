// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-cursor`
 * Purpose: Unit tests for the opaque cursor codec used by Doltgres work_items pagination.
 * Scope: Pure encode/decode round-trip plus error cases. Does not touch a database.
 * Invariants:
 *   - ROUND_TRIP_STABLE, decode(encode(c)) returns the original composite sort key.
 *   - MALFORMED_IS_REJECTED, non-base64url or structurally invalid input raises InvalidCursorError.
 * Side-effects: none
 * Links: bug.5162, packages/work-items/src/adapters/doltgres/cursor.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  type WorkItemCursor,
} from "../../src/adapters/doltgres/cursor.js";

describe("work-items-cursor codec", () => {
  it("round-trips a fully populated cursor", () => {
    const c: WorkItemCursor = {
      p: 1,
      r: 5,
      ts: "2026-04-30T12:00:00.000Z",
      id: "task.5042",
    };
    const decoded = decodeCursor(encodeCursor(c));
    expect(decoded).toEqual(c);
  });

  it("round-trips a cursor with null priority/rank", () => {
    const c: WorkItemCursor = {
      p: null,
      r: null,
      ts: "2026-04-30T12:00:00.000Z",
      id: "bug.5162",
    };
    const decoded = decodeCursor(encodeCursor(c));
    expect(decoded).toEqual(c);
  });

  it("encoded cursor uses base64url alphabet (no +, /, =)", () => {
    const encoded = encodeCursor({
      p: 1,
      r: 1,
      ts: "2026-04-30T12:00:00.000Z",
      id: "task.5042",
    });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("rejects malformed input", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow();
    expect(() => decodeCursor("aGVsbG8")).toThrow(); // valid base64, not JSON
  });

  it("rejects shape-mismatched JSON", () => {
    // base64url("{}")
    expect(() => decodeCursor("e30")).toThrow();
  });
});
