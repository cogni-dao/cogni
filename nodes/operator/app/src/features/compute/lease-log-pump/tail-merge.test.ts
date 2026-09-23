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
