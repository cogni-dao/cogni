// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/kpi-reader`
 * Purpose: A `kpiId → KpiReader` registry plus the v0 readers. Ships ONE
 *   verifier-independent reader (`external-count`, normalized to 0–100 against
 *   a denominator) and ONE fenced smoke reader (`confidence-smoke`) that exists
 *   only to prove the loop turns — never to gate a real goal.
 * Scope: Registry composition + readers. The count/confidence *sources* are
 *   injected functions (I/O lives behind them); this module is pure wiring.
 * Invariants:
 *   - KPI_VERIFIER_INDEPENDENT — `external-count` is independent because its
 *     source counts rows the loop does NOT author (the loop files `evidence_for`
 *     atoms onto its own hypothesis chain; the source reads a *separate* signal).
 *     `confidence-smoke` is `independent: false` and labelled SMOKE-TEST ONLY.
 *   - REGISTRY_REFUSES_SMOKE_FOR_REAL_GOAL — `read` returns null for an
 *     unregistered id AND throws `NonIndependentKpiReaderError` for a
 *     non-independent (smoke) reader unless `{ allowSmoke: true }` is passed
 *     (smoke tests only). The `independent` flag is the gate; the registry
 *     enforces it so no real goal is ever gated on a self-grading reader.
 * Side-effects: none (sources passed in do the I/O)
 * Links: docs/design/knowledge-goal-loop.md § worker ≠ verifier
 * @public
 */

import {
  type KpiReader,
  type KpiReaderRegistry,
  NonIndependentKpiReaderError,
} from "../port/kpi-reader.port.js";
import type { Goal } from "./goal-loop.js";

const clamp0to100 = (n: number): number => Math.max(0, Math.min(100, n));

// ---------------------------------------------------------------------------
// `external-count` — the verifier-independent v0 reader.
//
// Reads a raw count from a source the loop does NOT write to, then normalizes
// to 0–100 against a denominator (how many independent signals = "done"). This
// is the design's "external metric (a real number the loop does not author)"
// shape: the worker's job is to file evidence onto its own chain, while this
// reader's number comes from a separate count the worker never authors. The loop
// can therefore never hit its target by the *volume of its own evidence* — only
// by the independent count rising.
// ---------------------------------------------------------------------------

/**
 * A count source the loop does not author. `goal` is passed so the source can
 * scope its query (e.g. count distinct cited sources, count rows in another
 * domain/table, hit an external API). Returns a raw non-negative count.
 */
export type ExternalCountSource = (goal: Goal) => Promise<number>;

export interface ExternalCountReaderConfig {
  kpiId: string;
  source: ExternalCountSource;
  /** Count that maps to 100. `read = clamp(count / denominator * 100)`. */
  denominator: number;
}

export function createExternalCountReader(
  config: ExternalCountReaderConfig
): KpiReader {
  if (config.denominator <= 0) {
    throw new Error("external-count reader requires a positive denominator");
  }
  return {
    kpiId: config.kpiId,
    independent: true,
    async read(goal: Goal): Promise<number> {
      const count = await config.source(goal);
      return clamp0to100((count / config.denominator) * 100);
    },
  };
}

// ---------------------------------------------------------------------------
// `confidence-smoke` — SMOKE-TEST ONLY. NOT for real goals.
//
// Returns the goal hypothesis's OWN computed `confidence_pct`. This is
// self-grading: each `evidence_for` the loop files bumps that confidence, so
// the loop "hits target" by the volume of its own writes, not by independent
// truth (docs/design § worker ≠ verifier). Marked `independent: false` so a
// controller refuses it for a real goal. Exists purely to prove the loop turns
// end-to-end before a real KPI reader is wired.
//
// TODO(verifier): replace usage with a real independent reader (external-count
// against a defensible denominator, or a librarian/judge that grades the chain).
// ---------------------------------------------------------------------------

/** Reads the goal hypothesis's own confidence_pct (the self-grading number). */
export type OwnConfidenceSource = (goal: Goal) => Promise<number>;

export function createConfidenceSmokeReader(
  kpiId: string,
  source: OwnConfidenceSource
): KpiReader {
  return {
    kpiId,
    independent: false, // SMOKE-TEST ONLY — self-grading, never a real goal's KPI.
    async read(goal: Goal): Promise<number> {
      return clamp0to100(await source(goal));
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Build a `kpiId → reader` registry from a flat reader list. Duplicate ids
 * throw at construction (a goal must map to exactly one reader). `read` returns
 * null for an unregistered id so the controller can halt rather than guess.
 */
export function createKpiReaderRegistry(
  readers: readonly KpiReader[]
): KpiReaderRegistry {
  const byId = new Map<string, KpiReader>();
  for (const r of readers) {
    if (byId.has(r.kpiId)) {
      throw new Error(`duplicate KpiReader for kpiId '${r.kpiId}'`);
    }
    byId.set(r.kpiId, r);
  }
  return {
    get(kpiId: string): KpiReader | null {
      return byId.get(kpiId) ?? null;
    },
    async read(
      goal: Goal,
      opts?: { allowSmoke?: boolean }
    ): Promise<number | null> {
      const reader = byId.get(goal.kpiId);
      if (!reader) return null;
      // REGISTRY_REFUSES_SMOKE_FOR_REAL_GOAL — a real goal must never be gated
      // on a self-grading reader (KPI_VERIFIER_INDEPENDENT). Only smoke tests
      // may opt in to a fenced `independent: false` reader.
      if (!reader.independent && opts?.allowSmoke !== true) {
        throw new NonIndependentKpiReaderError(reader.kpiId);
      }
      return reader.read(goal);
    },
  };
}
