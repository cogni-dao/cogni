// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { mergeTail, serviceForLogName } from "./tail-merge";

describe("mergeTail", () => {
  it("ships the whole first window", () => {
    const merged = mergeTail([], ["a", "b"], 10);
    expect(merged.newLines).toEqual(["a", "b"]);
    expect(merged.nextTail).toEqual(["a", "b"]);
  });

  it("ships only the suffix beyond the overlap", () => {
    const first = mergeTail([], ["a", "b", "c"], 10);
    const second = mergeTail(first.nextTail, ["b", "c", "d", "e"], 10);
    expect(second.newLines).toEqual(["d", "e"]);
    expect(second.nextTail).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ships nothing when the window is fully shipped", () => {
    const merged = mergeTail(["a", "b", "c"], ["b", "c"], 10);
    expect(merged.newLines).toEqual([]);
  });

  it("treats a disjoint window as entirely new (at-least-once, never dropped)", () => {
    const merged = mergeTail(["a", "b"], ["x", "y"], 10);
    expect(merged.newLines).toEqual(["x", "y"]);
  });

  it("prefers the largest overlap for repeated identical lines", () => {
    const merged = mergeTail(["tick", "tick"], ["tick", "tick", "tick"], 10);
    // Two of the three window lines are already shipped; only one is new.
    expect(merged.newLines).toEqual(["tick"]);
  });

  it("finds the shipped tail inside a window longer than the retained tail (bug.5516)", () => {
    const lines = (from: number, to: number): string[] =>
      Array.from({ length: to - from }, (_, i) => `line ${from + i}`);
    // Poll 1: a 6-line window, but only 3 lines are retained (maxTail < window size).
    const first = mergeTail([], lines(0, 6), 3);
    expect(first.nextTail).toEqual(lines(3, 6));
    // Poll 2: one line was written; the provider window slid by one. The retained tail
    // ends mid-window, never at its head — only `line 6` is new.
    const second = mergeTail(first.nextTail, lines(1, 7), 3);
    expect(second.newLines).toEqual(["line 6"]);
    expect(second.nextTail).toEqual(lines(4, 7));
    // Poll 3: nothing new written — nothing re-shipped.
    const third = mergeTail(second.nextTail, lines(1, 7), 3);
    expect(third.newLines).toEqual([]);
  });

  it("prefers a full-tail match over a spurious short head overlap", () => {
    // `x` at the window head equals the tail's last line, but the whole tail [a,b,x]
    // appears later in the window — that alignment is the shipped position.
    const merged = mergeTail(["a", "b", "x"], ["x", "a", "b", "x", "n"], 10);
    expect(merged.newLines).toEqual(["n"]);
  });

  it("bounds the retained tail", () => {
    const merged = mergeTail(["a", "b", "c"], ["c", "d", "e"], 3);
    expect(merged.nextTail).toEqual(["c", "d", "e"]);
  });
});

describe("serviceForLogName", () => {
  it("maps a pod name to its longest declared service prefix", () => {
    const services = ["app", "paper-trader"];
    expect(serviceForLogName("app-7c9f8-abcde", services)).toBe("app");
    expect(serviceForLogName("paper-trader-1a2b3-xyz", services)).toBe(
      "paper-trader"
    );
  });

  it("never mis-attributes a dashed sibling to a shorter prefix", () => {
    expect(serviceForLogName("paper-trader-1", ["paper", "paper-trader"])).toBe(
      "paper-trader"
    );
  });

  it("falls back to the raw name when nothing matches", () => {
    expect(serviceForLogName("mystery-0", ["app"])).toBe("mystery-0");
  });
});
