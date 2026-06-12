// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/kpi-reader`
 * Purpose: Unit coverage for the KPI reader registry + the two v0 readers.
 *   Proves the registry routes by kpiId, the `external-count` reader is
 *   verifier-INDEPENDENT and normalizes to 0–100, and the `confidence-smoke`
 *   reader is fenced (`independent: false`).
 * Scope: Pure registry + readers (sources are injected fakes); does not use a DB.
 * Invariants: KPI_VERIFIER_INDEPENDENT, KPI_RANGE_0_100
 * Side-effects: none
 * Links: src/domain/kpi-reader.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { Goal } from "../src/domain/goal-loop.js";
import {
  createConfidenceSmokeReader,
  createExternalCountReader,
  createKpiReaderRegistry,
} from "../src/domain/kpi-reader.js";
import { NonIndependentKpiReaderError } from "../src/port/kpi-reader.port.js";

const GOAL: Goal = {
  hypothesisId: "goal-1",
  domain: "oss-ai",
  kpiId: "oss-frontier-coverage",
  target: 80,
  evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
};

describe("createExternalCountReader — verifier-independent", () => {
  it("is flagged independent", () => {
    const r = createExternalCountReader({
      kpiId: "oss-frontier-coverage",
      source: async () => 0,
      denominator: 10,
    });
    expect(r.independent).toBe(true);
    expect(r.kpiId).toBe("oss-frontier-coverage");
  });

  it("normalizes the external count to 0–100 against the denominator", async () => {
    const r = createExternalCountReader({
      kpiId: "oss-frontier-coverage",
      source: async () => 4,
      denominator: 5,
    });
    expect(await r.read(GOAL)).toBe(80);
  });

  it("clamps an over-target count to 100", async () => {
    const r = createExternalCountReader({
      kpiId: "k",
      source: async () => 99,
      denominator: 5,
    });
    expect(await r.read(GOAL)).toBe(100);
  });

  it("rejects a non-positive denominator at construction", () => {
    expect(() =>
      createExternalCountReader({
        kpiId: "k",
        source: async () => 1,
        denominator: 0,
      })
    ).toThrow();
  });
});

describe("createConfidenceSmokeReader — fenced, NOT independent", () => {
  it("is flagged NOT independent (self-grading, smoke-test only)", () => {
    const r = createConfidenceSmokeReader("k", async () => 30);
    expect(r.independent).toBe(false);
  });

  it("passes through the own-confidence number, clamped", async () => {
    const r = createConfidenceSmokeReader("k", async () => 150);
    expect(await r.read(GOAL)).toBe(100);
  });
});

describe("createKpiReaderRegistry", () => {
  it("routes a goal to its registered reader by kpiId", async () => {
    const registry = createKpiReaderRegistry([
      createExternalCountReader({
        kpiId: "oss-frontier-coverage",
        source: async () => 8,
        denominator: 10,
      }),
    ]);
    expect(registry.get("oss-frontier-coverage")?.independent).toBe(true);
    expect(await registry.read(GOAL)).toBe(80);
  });

  it("returns null for an unregistered kpiId", async () => {
    const registry = createKpiReaderRegistry([]);
    expect(registry.get("nope")).toBeNull();
    expect(await registry.read(GOAL)).toBeNull();
  });

  it("rejects duplicate readers for the same kpiId", () => {
    const make = () =>
      createExternalCountReader({
        kpiId: "dup",
        source: async () => 1,
        denominator: 2,
      });
    expect(() => createKpiReaderRegistry([make(), make()])).toThrow();
  });

  it("REFUSES a non-independent (smoke) reader for a real goal", async () => {
    const registry = createKpiReaderRegistry([
      createConfidenceSmokeReader("oss-frontier-coverage", async () => 95),
    ]);
    await expect(registry.read(GOAL)).rejects.toBeInstanceOf(
      NonIndependentKpiReaderError
    );
  });

  it("reads a smoke reader only when allowSmoke is explicitly set", async () => {
    const registry = createKpiReaderRegistry([
      createConfidenceSmokeReader("oss-frontier-coverage", async () => 42),
    ]);
    expect(await registry.read(GOAL, { allowSmoke: true })).toBe(42);
  });
});
