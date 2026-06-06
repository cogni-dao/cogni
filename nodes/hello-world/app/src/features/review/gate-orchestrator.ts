// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/gate-orchestrator`
 * Purpose: Deterministic gate runner that processes gates in order with timeout and crash isolation.
 * Scope: Orchestrates gate evaluation. Does not own graph executor or GitHub client lifecycle.
 * Invariants: Gates run in declared order. Per-gate timeout (120s default). Crash → neutral. Aggregation: fail > neutral > pass.
 * Side-effects: IO (delegates to gates which may call LLM)
 * Links: task.0153
 * @public
 */

import type { GateConfig, Rule } from "@cogni/repo-spec";
import type { Logger } from "pino";

import type { GraphExecutorPort } from "@/ports";

import { evaluateAiRule } from "./gates/ai-rule";
import { evaluateReviewLimits } from "./gates/review-limits";
import type {
  EvidenceBundle,
  GateResult,
  GateStatus,
  ReviewResult,
} from "./types";

/** Default per-gate timeout in milliseconds. */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

/** Dependencies injected into the orchestrator. */
export interface OrchestratorDeps {
  readonly executor: GraphExecutorPort;
  readonly model: string;
  readonly log: Logger;
  /** Resolves a rule_file name to a parsed Rule. */
  readonly loadRule: (ruleFile: string) => Rule;
  readonly gateTimeoutMs?: number;
}

/**
 * Run all gates in order. Returns aggregate result.
 * Aggregation priority: fail > neutral > pass.
 */
export async function runGates(
  gates: readonly GateConfig[],
  evidence: EvidenceBundle,
  deps: OrchestratorDeps
): Promise<ReviewResult> {
  const gateResults: GateResult[] = [];
  const timeoutMs = deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  for (const gate of gates) {
    const result = await runSingleGate(gate, evidence, deps, timeoutMs);
    gateResults.push(result);
  }

  // Aggregate: fail > neutral > pass
  const conclusion = aggregateStatus(gateResults.map((r) => r.status));

  return { conclusion, gateResults };
}

/**
 * Run a single gate with timeout and crash isolation.
 */
async function runSingleGate(
  gate: GateConfig,
  evidence: EvidenceBundle,
  deps: OrchestratorDeps,
  timeoutMs: number
): Promise<GateResult> {
  const gateId =
    "id" in gate && gate.id ? gate.id : `${gate.type}-${Date.now()}`;

  try {
    const resultPromise = executeGate(gate, evidence, deps);

    // Per-gate timeout → neutral on timeout (timer cleared on completion)
    const { promise: timeoutPromise, clear } = timeout(timeoutMs, gateId);
    try {
      return await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      clear();
    }
  } catch (error) {
    // Crash isolation: gate crash → neutral
    deps.log.warn(
      { gateId, gateType: gate.type, error: String(error) },
      "Gate crashed — defaulting to neutral"
    );
    return {
      gateId,
      gateType: gate.type,
      status: "neutral",
      summary: `Gate crashed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Dispatch to the appropriate gate implementation.
 */
async function executeGate(
  gate: GateConfig,
  evidence: EvidenceBundle,
  deps: OrchestratorDeps
): Promise<GateResult> {
  switch (gate.type) {
    case "review-limits":
      return evaluateReviewLimits(evidence, gate.with);

    case "ai-rule": {
      const rule = deps.loadRule(gate.with.rule_file);
      return evaluateAiRule({
        rule,
        evidence,
        executor: deps.executor,
        model: deps.model,
      });
    }
  }
}

/**
 * Aggregate gate statuses: fail > neutral > pass.
 */
function aggregateStatus(statuses: readonly GateStatus[]): GateStatus {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "neutral")) return "neutral";
  return "pass";
}

/**
 * Timeout helper that resolves to a neutral GateResult.
 * Returns the promise and a clear function to cancel the timer.
 */
function timeout(
  ms: number,
  gateId: string
): { promise: Promise<GateResult>; clear: () => void } {
  let timerId: ReturnType<typeof setTimeout>;
  const promise = new Promise<GateResult>((resolve) => {
    timerId = setTimeout(() => {
      resolve({
        gateId,
        gateType: "timeout",
        status: "neutral",
        summary: `Gate timed out after ${ms / 1000}s`,
      });
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timerId) };
}
