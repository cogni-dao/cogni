// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/kpi-reader`
 * Purpose: A `kpiId → KpiReader` registry plus the v0 readers. Ships ONE
 *   verifier-independent reader (`external-count`, normalized to 0–100 against
 *   a denominator) and ONE fenced smoke reader (`confidence-smoke`) that exists
 *   only to prove the loop turns — never to gate a real goal.
 * Scope: Registry composition + readers; does not do I/O — the count/confidence
 *   *sources* are injected functions (I/O lives behind them), this is pure wiring.
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
// `judge` — the independent LLM-judge reader for one-off qualitative goals.
//
// The everyday one-off case: the goal carries its success criterion in prose
// (`goal-success-criterion`), and a SEPARATE judge model scores the
// accumulated evidence against that criterion → 0–100. This is the Claude
// `/goal` Haiku-evaluator pattern, and the scalable default — you write the
// success sentence, not reader code.
//
// `independent: true` is gated on the judge reading a signal the loop does NOT
// author. The judge here reads the goal's *evidence chain* (the cited atoms)
// and its prose criterion — NOT the goal row's own `confidence_pct` (the
// self-grading number every `evidence_for` edge bumps). The score function is
// injected so the I/O (an LLM call, or a deterministic heuristic) lives behind
// the reader.
//
// HONEST v1 CAVEAT (KPI_VERIFIER_INDEPENDENT): a judge that grades the loop's
// OWN evidence atoms still shares the worker's blind spot (the Reflexion
// failure mode). v1 MUST point the judge at EXTERNAL ground truth — re-derive
// the criterion from primary sources, or a held-out check the worker can't see
// — not only the chain the loop wrote. v0 grades the chain so the primitive is
// observably runnable end-to-end; do not promote a real high-stakes goal onto
// the v0 judge without the ground-truth hardening.
// ---------------------------------------------------------------------------

export const JUDGE_KPI_ID = "judge" as const;

/** One piece of accumulated evidence the judge scores against the criterion. */
export interface JudgeEvidenceAtom {
  id: string;
  title: string;
  content: string;
}

/** What the judge scores: the goal's prose criterion + the evidence so far. */
export interface JudgeInput {
  goal: Goal;
  /** The goal's prose success sentence (from `goal-success-criterion`). */
  criterion: string;
  /** The `evidence_for` atoms the loop has filed onto the goal chain so far. */
  evidence: readonly JudgeEvidenceAtom[];
}

/**
 * Scores `criterion` against `evidence` → 0–100. Injected so the I/O (an
 * independent judge-model call, or a cheap deterministic heuristic) lives
 * behind the reader. MUST NOT read the goal's own `confidence_pct`.
 */
export type JudgeScoreFn = (input: JudgeInput) => Promise<number>;

/** Loads the goal's prose criterion + its `evidence_for` atoms (independent of confidence_pct). */
export type JudgeEvidenceSource = (
  goal: Goal
) => Promise<{ criterion: string; evidence: readonly JudgeEvidenceAtom[] }>;

export interface JudgeReaderConfig {
  /** KPI id this judge serves (default `judge` for the `metric:judge` binding). */
  kpiId?: string;
  /** Reads the criterion + evidence chain (NOT the goal's confidence_pct). */
  source: JudgeEvidenceSource;
  /** Scores criterion-vs-evidence → 0–100 (LLM call or deterministic heuristic). */
  score: JudgeScoreFn;
}

export function createJudgeReader(config: JudgeReaderConfig): KpiReader {
  return {
    kpiId: config.kpiId ?? JUDGE_KPI_ID,
    // Independent: scores the criterion + the loop's evidence atoms, never the
    // goal row's self-grading confidence_pct. (v1 hardens to external ground
    // truth — see the block comment above.)
    independent: true,
    async read(goal: Goal): Promise<number> {
      const { criterion, evidence } = await config.source(goal);
      return clamp0to100(await config.score({ goal, criterion, evidence }));
    },
  };
}

/**
 * The v0 deterministic judge heuristic — the ONE thing the design permits to
 * stub (never the loop wiring or the EDO writes). Scores by the count of
 * distinct evidence atoms relative to the goal's `target` read as the
 * "atoms-to-done" denominator: `score = clamp(atoms / (target/20) * 100)`,
 * i.e. with the default target=80 the goal closes (validates) once ~4 distinct
 * cited atoms accumulate. Cheap, deterministic, spends zero tokens — it proves
 * the loop turns + accumulates evidence + closes on budget. A real judge model
 * replaces this `score` fn without touching the reader/loop.
 */
export function deterministicJudgeScore(input: JudgeInput): Promise<number> {
  const atomsToDone = Math.max(1, Math.round(input.goal.target / 20));
  const distinct = new Set(input.evidence.map((e) => e.id)).size;
  return Promise.resolve(clamp0to100((distinct / atomsToDone) * 100));
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
