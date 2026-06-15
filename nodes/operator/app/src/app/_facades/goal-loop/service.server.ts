// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/goal-loop/service.server`
 * Purpose: Server-side I/O for the AI goal + KPI loop. Backs the four
 *   `GoalLoopActivities` the `GoalLoopWorkflow` proxies — load the goal,
 *   read its KPI via a verifier-independent reader, take ONE evidence step,
 *   and file the closing outcome. All reads/writes go through the container's
 *   `knowledgeStorePort` + `edoCapability` (the same EDO plane the public
 *   `/api/v1/edo/*` routes use, system-principal direct-to-main).
 * Scope: Operator-node I/O only. The pure loop control + halt predicate live in
 *   `@cogni/knowledge-store/goal-loop` and the `GoalLoopWorkflow`; this module
 *   never decides whether to halt — it executes the activities the workflow asks for.
 * Invariants:
 *   - KPI_VERIFIER_INDEPENDENT: `readGoalKpi` reads through the
 *     `KpiReaderRegistry` independent read (the `metric:judge` reader scores the
 *     goal's prose criterion vs its evidence chain — NEVER `recomputeConfidence`
 *     of the goal's own row).
 *   - ACTIVITY_IDEMPOTENCY: the per-step atom id is the stable business key
 *     `${hypothesisId}/${iteration}`; `addKnowledge` upserts and `addCitation`
 *     is idempotent on `(citing,cited,type)`, so a retry can't double-write.
 *   - EVIDENCE_VIA_EDO_PLANE: the step writes an atom + an `evidence_for`
 *     citation onto the goal hypothesis (NOT `core__knowledge_write`, which
 *     can't author `evidence_for`); the outcome closes via `edoCapability`.
 *   - SYSTEM_PRINCIPAL: writes are stamped `source_type='derived'`,
 *     `source_ref='goal-loop:<hypothesisId>'`.
 * Side-effects: IO (Doltgres read/write via container ports)
 * Links: docs/design/knowledge-goal-loop.md § Pareto MVP, packages/knowledge-store
 * @public
 */

import type { EdoCapability } from "@cogni/ai-tools";
import {
  createJudgeReader,
  createKpiReaderRegistry,
  deterministicJudgeScore,
  type Goal,
  goalFromRow,
  JUDGE_KPI_ID,
  type JudgeEvidenceAtom,
  type KnowledgeStorePort,
  type KpiReaderRegistry,
  stepGraphIdFromTags,
  successCriterionFromTags,
} from "@cogni/knowledge-store";

const GOAL_LOOP_SOURCE_REF = (hypothesisId: string) =>
  `goal-loop:${hypothesisId}` as const;

export interface GoalLoopDeps {
  store: KnowledgeStorePort;
  edo: EdoCapability;
  /** Wall-clock read (injected for testability). */
  now: () => Date;
}

export interface LoadedGoal {
  goal: Goal;
  budget: {
    maxIterations: number;
    maxTokens: number;
    maxRecursionDepth: number;
    maxStalledIterations: number;
  };
  stepGraphId: string | null;
}

// ---------------------------------------------------------------------------
// KPI registry — the `metric:judge` reader (independent of the goal's writes).
//
// The judge's *evidence source* reads the goal's `evidence_for` atom chain (the
// findings the loop filed) + the goal's prose criterion — it never reads the
// goal row's own `confidence_pct`. The *score* fn is the v0 deterministic
// heuristic (the one permitted stub): a real judge model swaps in here without
// touching the loop wiring or the EDO writes.
// ---------------------------------------------------------------------------

function buildKpiRegistry(deps: GoalLoopDeps): KpiReaderRegistry {
  const judge = createJudgeReader({
    kpiId: JUDGE_KPI_ID,
    source: async (goal: Goal) => {
      const criterion =
        successCriterionFromTags(
          (await loadRowTags(deps, goal.hypothesisId)) ?? []
        ) ?? goal.hypothesisId;
      const evidence = await loadEvidenceAtoms(deps, goal.hypothesisId);
      return { criterion, evidence };
    },
    score: deterministicJudgeScore,
  });
  return createKpiReaderRegistry([judge]);
}

async function loadRowTags(
  deps: GoalLoopDeps,
  hypothesisId: string
): Promise<readonly string[] | null> {
  const row = await deps.store.getKnowledge(hypothesisId);
  return row?.tags ?? null;
}

/**
 * Read the goal's `evidence_for` atoms — the cited findings the loop authored.
 * `listCitationsByCitedId` returns edges pointing AT the goal; we keep the
 * `evidence_for` ones and hydrate each citing atom. This is the independent
 * signal the judge scores; it is NOT the goal's `confidence_pct`.
 */
async function loadEvidenceAtoms(
  deps: GoalLoopDeps,
  hypothesisId: string
): Promise<JudgeEvidenceAtom[]> {
  const edges = await deps.store.listCitationsByCitedId(hypothesisId);
  const atoms: JudgeEvidenceAtom[] = [];
  for (const edge of edges) {
    if (edge.citationType !== "evidence_for") continue;
    const row = await deps.store.getKnowledge(edge.citingId);
    if (row) {
      atoms.push({ id: row.id, title: row.title, content: row.content });
    }
  }
  return atoms;
}

// ---------------------------------------------------------------------------
// Activity bodies
// ---------------------------------------------------------------------------

/** Project the goal hypothesis row → Goal + budget + step graph. Null if not a goal. */
export async function loadGoal(
  deps: GoalLoopDeps,
  hypothesisId: string
): Promise<(LoadedGoal & { nowIso: string }) | null> {
  const row = await deps.store.getKnowledge(hypothesisId);
  if (!row) return null;
  const projected = goalFromRow(row);
  if (projected === null) return null;
  return {
    goal: projected.goal,
    budget: projected.budget,
    stepGraphId: stepGraphIdFromTags(row.tags ?? []),
    nowIso: deps.now().toISOString(),
  };
}

/**
 * Read the goal's KPI via the verifier-INDEPENDENT registry. Throws if the
 * goal is not a goal or its kpiId has no registered reader (the workflow halts
 * rather than guess). The registry refuses a non-independent reader for a real
 * goal (KPI_VERIFIER_INDEPENDENT).
 */
export async function readGoalKpi(
  deps: GoalLoopDeps,
  hypothesisId: string
): Promise<number> {
  const row = await deps.store.getKnowledge(hypothesisId);
  if (!row) throw new Error(`goal '${hypothesisId}' not found`);
  const projected = goalFromRow(row);
  if (projected === null)
    throw new Error(`row '${hypothesisId}' is not a goal`);
  const registry = buildKpiRegistry(deps);
  const kpi = await registry.read(projected.goal);
  if (kpi === null) {
    throw new Error(
      `no KPI reader registered for '${projected.goal.kpiId}' (goal '${hypothesisId}')`
    );
  }
  return kpi;
}

export interface StepResult {
  ok: boolean;
  atomId: string;
  tokensSpent: number;
}

/**
 * Take ONE loop step: file ONE `evidence_for`-cited atom onto the goal's chain.
 * The atom id is the stable business key `${hypothesisId}/${iteration}` so a
 * Temporal retry reuses it (ACTIVITY_IDEMPOTENCY). The finding content is
 * synthesized deterministically for the MVP — the `stepGraphId` is threaded
 * through so a v1 implement can run that graph to produce the finding instead
 * (without touching this write path).
 */
export async function runGoalStep(
  deps: GoalLoopDeps,
  input: {
    hypothesisId: string;
    domain: string;
    idempotencyKey: string;
    iteration: number;
    stepGraphId: string;
  }
): Promise<StepResult> {
  const atomId = input.idempotencyKey;
  await deps.store.addKnowledge({
    id: atomId,
    domain: input.domain,
    title: `goal step ${input.iteration + 1} — finding for '${input.hypothesisId}'`,
    content:
      `Iteration ${input.iteration + 1} of the goal loop for '${input.hypothesisId}'. ` +
      `Step graph: ${input.stepGraphId}. This atom is one unit of cited evidence ` +
      `on the goal's chain; the independent judge scores the accumulated chain ` +
      `against the goal's success criterion.`,
    entryType: "finding",
    sourceType: "derived",
    sourceRef: GOAL_LOOP_SOURCE_REF(input.hypothesisId),
  });
  // evidence_for: atom → goal hypothesis. Idempotent on (citing,cited,type).
  await deps.store.addCitation({
    citingId: atomId,
    citedId: input.hypothesisId,
    citationType: "evidence_for",
  });
  await deps.store.commit(
    `goal-loop: step ${input.iteration + 1} evidence for '${input.hypothesisId}'`
  );
  return { ok: true, atomId, tokensSpent: 0 };
}

/**
 * File the goal's closing outcome (validates|invalidates) + recompute
 * confidence. Idempotent on `${hypothesisId}` — the resolver refuses a second
 * resolving citation, so a Temporal retry returns the already-resolved state.
 */
export async function fileGoalOutcome(
  deps: GoalLoopDeps,
  input: {
    hypothesisId: string;
    domain: string;
    edge: "validates" | "invalidates";
    reason: string;
    lastKpi: number;
    target: number;
  }
): Promise<void> {
  await deps.edo.recordOutcome({
    id: `${input.hypothesisId}/outcome`,
    domain: input.domain,
    title: `goal ${input.edge === "validates" ? "met" : "closed"} — ${input.reason}`,
    content:
      `Goal loop closed: ${input.reason}. KPI ${input.lastKpi}/${input.target} ` +
      `(${input.edge}). Independent judge scored the goal's evidence chain ` +
      `against its success criterion.`,
    hypothesisId: input.hypothesisId,
    edge: input.edge,
    sourceType: "derived",
    sourceRef: GOAL_LOOP_SOURCE_REF(input.hypothesisId),
    sourceNode: "operator",
  });
}
