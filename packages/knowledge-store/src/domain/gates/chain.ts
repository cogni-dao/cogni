// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates/chain`
 * Purpose: Runs a sequence of gates against a candidate. Collects all errors from the first failing gate's tier; gates within a tier run in parallel for richer error reporting; gates short-circuit between tiers.
 * Scope: Pure orchestration logic over the KnowledgeGate interface. Does not perform I/O, instantiate gates, or know about specific gate implementations.
 * Invariants:
 *   - GATES_FAIL_CLOSED: first failing tier stops the chain.
 *   - SAME_TIER_PARALLEL: gates within one tier run together so users see all fixable issues at once (don't make them play whack-a-mole).
 * Side-effects: none
 * Links: work/projects/proj.knowledge-syntropy.md
 * @public
 */

import type {
  GateContext,
  GateError,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "./types.js";

/**
 * Run a list of gates against a candidate.
 *
 * Algorithm: group gates by `tier`. For each tier in order:
 *  1. Run all gates in that tier concurrently.
 *  2. Collect errors. If any gate failed, return all errors from this tier.
 *  3. If all passed, the candidate may have been sanitized by any gate;
 *     downstream tiers see the LAST gate's sanitized form (gates in the same
 *     tier are concurrent — they all see the input candidate, not each
 *     other's outputs. Cross-tier sanitization flows through.)
 *  4. After all tiers pass, return ok with the final sanitized candidate.
 */
export async function runGateChain(
  gates: readonly KnowledgeGate[],
  candidate: KnowledgeWriteCandidate,
  ctx: GateContext
): Promise<GateResult> {
  const tiers = groupByTier(gates);
  let current = candidate;

  for (const tierGates of tiers) {
    const results = await Promise.all(
      tierGates.map((g) => g.check(current, ctx))
    );
    const errors: GateError[] = [];
    let sanitized = current;
    for (const r of results) {
      if (!r.ok) {
        errors.push(...r.errors);
      } else {
        // Last successful gate in this tier wins for sanitization — gates in
        // the same tier are expected to touch disjoint fields, so this is
        // safe in practice; cross-tier flow is the right place for chained
        // normalization.
        sanitized = r.candidate;
      }
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    current = sanitized;
  }

  return { ok: true, candidate: current };
}

function groupByTier(
  gates: readonly KnowledgeGate[]
): readonly (readonly KnowledgeGate[])[] {
  const order: KnowledgeGate["tier"][] = ["v0", "v1", "v2"];
  return order
    .map((tier) => gates.filter((g) => g.tier === tier))
    .filter((g) => g.length > 0);
}
