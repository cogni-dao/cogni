// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/activity-types`
 * Purpose: Explicit activity interface definitions consumed by workflows via proxyActivities<T>().
 * Scope: Type-only — does not contain implementations or I/O. Input/output types mirror the worker's
 *   activity factories but live here so the package has no import dependency on the worker service.
 * Invariants:
 *   - Per ACTIVITY_TYPES_EXPLICIT: interfaces defined here, not inferred from factories
 *   - All input/output types are plain serializable objects (JSON-safe for Temporal wire format)
 *   - Per NO_SERVICE_IMPORTS: never imports from services/
 * Side-effects: none
 * Links: docs/spec/temporal-patterns.md, docs/spec/packages-architecture.md
 * @public
 */

// ---------------------------------------------------------------------------
// Scheduler Activities (graph-run CRUD + execution)
// ---------------------------------------------------------------------------

/** Formerly `Activities` — renamed for clarity. Same shape as ReturnType<typeof createActivities>. */
export interface SchedulerActivities {
  validateGrantActivity(input: {
    nodeId: string;
    grantId: string;
    graphId: string;
  }): Promise<void>;

  createGraphRunActivity(input: {
    nodeId: string;
    runId: string;
    graphId?: string;
    runKind?: string;
    triggerSource?: string;
    triggerRef?: string;
    requestedBy?: string;
    dbScheduleId?: string;
    scheduledFor?: string;
    stateKey?: string;
  }): Promise<void>;

  executeGraphActivity(input: {
    nodeId: string;
    temporalScheduleId?: string;
    graphId: string;
    executionGrantId: string | null;
    input: Record<string, unknown>;
    scheduledFor: string;
    runId: string;
  }): Promise<{
    ok: boolean;
    runId: string;
    traceId: string | null;
    errorCode?: string;
    structuredOutput?: unknown;
  }>;

  updateGraphRunActivity(input: {
    nodeId: string;
    runId: string;
    status: "running" | "success" | "error" | "skipped" | "cancelled";
    traceId?: string | null;
    errorMessage?: string;
    errorCode?: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Review Activities (GitHub I/O for PR review workflow)
// ---------------------------------------------------------------------------

import type { OwningNode } from "@cogni/repo-spec";

export interface ReviewActivities {
  createCheckRunActivity(input: {
    owner: string;
    repo: string;
    headSha: string;
    installationId: number;
  }): Promise<number>;

  fetchPrContextActivity(input: {
    owner: string;
    repo: string;
    prNumber: number;
    installationId: number;
  }): Promise<{
    evidence: Record<string, unknown>;
    gatesConfig: { gates: unknown[]; failOnError: boolean };
    rules: Record<string, unknown>;
    graphMessages: Array<{ role: string; content: string }>;
    responseFormat: { prompt: string; schemaId: string };
    modelRef: { providerKey: string; modelId: string; connectionId?: string };
    repoSpecYaml?: string;
    /** Filenames from GitHub `pulls.listFiles`. Used for owning-domain resolution. */
    changedFiles: string[];
    /**
     * Owning domain resolved via `extractOwningNode(rootSpec, changedFiles)`.
     * Workflow dispatches on `kind`: `single` continues review; `conflict` and
     * `miss` short-circuit through `postRoutingDiagnosticActivity`.
     */
    owningNode: OwningNode;
  }>;

  postReviewResultActivity(input: Record<string, unknown>): Promise<void>;

  /**
   * Post a routing-diagnostic outcome to GitHub: PR comment + neutral check run.
   * Used for `conflict` (cross-domain PR) and `miss` (no recognizable scope).
   * Spends zero AI tokens — formatter is pure, no GraphRunWorkflow child.
   */
  postRoutingDiagnosticActivity(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    installationId: number;
    checkRunId?: number;
    owningNode: OwningNode;
    changedFiles: readonly string[];
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sweep Activities (queue-sweeping agent roles)
// ---------------------------------------------------------------------------

/** Work item summary returned by fetchWorkItemsActivity. */
export interface SweepWorkItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  rank?: number;
  summary?: string;
}

export interface SweepActivities {
  /** Fetch work items matching the role's queue filter, sorted by priority. */
  fetchWorkItemsActivity(input: {
    statuses?: string[];
    labels?: string[];
    types?: string[];
  }): Promise<SweepWorkItem[]>;

  /** Log sweep result and optionally post to Discord. */
  processSweepResultActivity(input: {
    roleId: string;
    itemId: string;
    itemTitle: string;
    outcome: "success" | "error" | "no_op";
    runId: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Goal-loop Activities (AI goal + KPI loop I/O — docs/design/knowledge-goal-loop.md)
//
// All read/write through the owning node's API (EXECUTION_VIA_SERVICE_API); the
// worker holds no DB creds on this path. `loadGoalStateActivity` projects the
// goal hypothesis row → Goal/budget + accumulated LoopState (read from the EDO
// chain + run ledger). `readKpiActivity` reads the KPI via a verifier-INDEPENDENT
// reader (NEVER recomputeConfidence of the goal's own row). `fileGoalOutcome…`
// records the validates/invalidates outcome. `recordStepResult…` persists the
// step accounting (the durable iteration history is the atom + its citation).
// ---------------------------------------------------------------------------

/** JSON-serializable projection of a Goal (Temporal wire format — dates as ISO strings). */
export interface GoalWire {
  hypothesisId: string;
  domain: string;
  kpiId: string;
  target: number;
  /** ISO timestamp of the row's evaluate_at. */
  evaluateAt: string;
}

export interface LoopBudgetWire {
  maxIterations: number;
  maxTokens: number;
  maxRecursionDepth: number;
  maxStalledIterations: number;
}

export interface GoalLoopActivities {
  /**
   * Project the goal hypothesis row → Goal + budget. Returns null if the row is
   * not a goal (no `metric:` strategy / undecodable budget). `nowIso` is the
   * activity's read clock, injected so the workflow's halt guard stays
   * deterministic. The MVP loop runs internally bounded by `LoopBudget` in
   * workflow memory, so iteration/token accounting is NOT read back from Dolt —
   * this activity loads only the static goal + budget once at loop start.
   */
  loadGoalActivity(input: { nodeId: string; hypothesisId: string }): Promise<{
    goal: GoalWire;
    budget: LoopBudgetWire;
    /** Graph the per-tick step runs (from `goal-step-graph` tag, else null). */
    stepGraphId: string | null;
    nowIso: string;
  } | null>;

  /**
   * Read the goal's KPI via its verifier-INDEPENDENT reader (0–100). Per
   * KPI_VERIFIER_INDEPENDENT the implementation MUST resolve through the
   * `KpiReaderRegistry` independent read (which refuses a non-independent reader
   * for a real goal); it MUST NEVER return `recomputeConfidence` of the goal's
   * own row — that is the self-grading trap the loop exists to avoid.
   */
  readKpiActivity(input: {
    nodeId: string;
    hypothesisId: string;
  }): Promise<number>;

  /**
   * Take ONE loop step: file ONE `evidence_for`-cited atom onto the goal's
   * chain. Per ACTIVITY_IDEMPOTENCY the atom id is keyed on the stable business
   * key `${hypothesisId}/${iteration}` so a Temporal retry reuses the same atom
   * rather than double-writing. Returns the tokens the step spent (for the
   * in-workflow budget accounting). `stepGraphId` is goal-level config (any
   * graph can drive a goal); the implementation runs that graph to produce the
   * finding, or falls back to a deterministic finding for the MVP.
   */
  runStepActivity(input: {
    nodeId: string;
    hypothesisId: string;
    domain: string;
    /** Stable business key `${hypothesisId}/${iteration}` — writes this atom once. */
    idempotencyKey: string;
    iteration: number;
    stepGraphId: string;
  }): Promise<{ ok: boolean; atomId: string; tokensSpent: number }>;

  /**
   * File the goal's outcome (validates|invalidates) + recompute confidence.
   * Per ACTIVITY_IDEMPOTENCY the implementation MUST key on `${hypothesisId}`
   * (one outcome per goal) so a Temporal retry cannot file a second outcome.
   */
  fileGoalOutcomeActivity(input: {
    nodeId: string;
    hypothesisId: string;
    domain: string;
    edge: "validates" | "invalidates";
    reason: string;
    lastKpi: number;
    target: number;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ledger Activities (attribution pipeline I/O)
// ---------------------------------------------------------------------------

export interface LedgerActivities {
  ensureEpochForWindow(input: {
    periodStart: string;
    periodEnd: string;
    weightConfig: Record<string, number>;
  }): Promise<{
    epochId: string;
    status: string;
    isNew: boolean;
    weightConfig: Record<string, number>;
  }>;

  findStaleOpenEpoch(input: {
    periodStart: string;
    periodEnd: string;
  }): Promise<{
    staleEpoch: {
      epochId: string;
      weightConfig: Record<string, number>;
      periodStart: string;
      periodEnd: string;
    } | null;
  }>;

  transitionEpochForWindow(input: {
    periodStart: string;
    periodEnd: string;
    weightConfig: Record<string, number>;
    closeParams: {
      staleEpochId: string;
      staleWeightConfig: Record<string, number>;
      approvers: string[];
      attributionPipeline: string;
      evaluations: ReadonlyArray<{
        nodeId: string;
        epochId: string;
        evaluationRef: string;
        status: "draft" | "locked";
        algoRef: string;
        inputsHash: string;
        payloadHash: string;
        payloadJson: Record<string, unknown>;
      }>;
      artifactsHash: string;
    };
  }): Promise<{
    epochId: string;
    status: string;
    isNew: boolean;
    weightConfig: Record<string, number>;
    closedStaleEpochId: string;
  }>;

  ensurePoolComponents(input: {
    epochId: string;
    baseIssuanceCredits: string;
  }): Promise<{ componentsEnsured: number }>;

  loadCursor(input: {
    source: string;
    stream: string;
    sourceRef: string;
  }): Promise<string | null>;

  collectFromSource(input: {
    source: string;
    streams: string[];
    cursorValue: string | null;
    periodStart: string;
    periodEnd: string;
  }): Promise<{
    events: unknown[];
    nextCursorValue: string;
    nextCursorStreamId: string;
    producerVersion: string;
  }>;

  insertReceipts(input: {
    events: unknown[];
    producerVersion: string;
  }): Promise<void>;

  saveCursor(input: {
    source: string;
    stream: string;
    sourceRef: string;
    cursorValue: string;
  }): Promise<void>;

  resolveStreams(input: { source: string }): Promise<{ streams: string[] }>;

  materializeSelection(input: {
    epochId: string;
    attributionPipeline: string;
  }): Promise<{
    totalReceipts: number;
    newSelections: number;
    resolved: number;
    unresolved: number;
  }>;

  computeAllocations(input: {
    epochId: string;
    attributionPipeline: string;
    weightConfig: Record<string, number>;
  }): Promise<{
    totalAllocations: number;
    totalProposedUnits: string;
  }>;

  finalizeEpoch(input: {
    epochId: string;
    signature: string;
    signerAddress: string;
  }): Promise<{
    statementId: string;
    poolTotalCredits: string;
    finalAllocationSetHash: string;
    statementLineCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Enrichment Activities (draft/locked evaluation pipeline)
// ---------------------------------------------------------------------------

export interface EnrichmentActivities {
  deriveWeightConfig(input: {
    attributionPipeline: string;
  }): Promise<{ weightConfig: Record<string, number> }>;

  evaluateEpochDraft(input: {
    epochId: string;
    attributionPipeline: string;
  }): Promise<{ evaluationRefs: string[]; receiptCount: number }>;

  buildLockedEvaluations(input: {
    epochId: string;
    attributionPipeline: string;
  }): Promise<{
    evaluations: ReadonlyArray<{
      nodeId: string;
      epochId: string;
      evaluationRef: string;
      status: "draft" | "locked";
      algoRef: string;
      inputsHash: string;
      payloadHash: string;
      payloadJson: Record<string, unknown>;
    }>;
    artifactsHash: string;
  }>;
}
