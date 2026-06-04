// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { assertAdditive, escapeRef, escapeValue } from "../src/sql/escape.js";

describe("escape + additive guard", () => {
  it("escapeValue escapes single quotes and strips NUL", () => {
    expect(escapeValue("o'brien")).toBe("'o''brien'");
    expect(escapeValue("a\0b")).toBe("'ab'");
  });

  it("escapeRef accepts safe Dolt refs, rejects injection", () => {
    expect(escapeRef("origin")).toBe("'origin'");
    expect(escapeRef("main")).toBe("'main'");
    expect(() => escapeRef("main'; DROP TABLE x; --")).toThrow(
      /Invalid Dolt ref/
    );
    expect(() => escapeRef("a b")).toThrow(/Invalid Dolt ref/);
  });

  it("assertAdditive passes the only statements the worker emits", () => {
    expect(() =>
      assertAdditive("SELECT dolt_remote('add', 'origin', 'https://x/y')")
    ).not.toThrow();
    expect(() =>
      assertAdditive("SELECT dolt_push('origin', 'main')")
    ).not.toThrow();
  });

  it("assertAdditive refuses every destructive op (HARD SAFETY)", () => {
    for (const sql of [
      "SELECT dolt_reset('--hard')",
      "SELECT dolt_push('origin', 'main', '--force')",
      "DROP TABLE work_items",
      "DROP DATABASE knowledge_operator",
      "TRUNCATE knowledge",
      "DELETE FROM knowledge",
      "SELECT dolt_branch('-d', 'main')",
    ]) {
      expect(() => assertAdditive(sql), sql).toThrow(/destructive/);
    }
  });
});
