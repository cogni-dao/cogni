// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/domain/review`
 * Purpose: Pure domain logic for PR review — criteria evaluation, markdown formatting, and routing-diagnostic comment formatting.
 * Scope: Deterministic functions over serializable data. Does not perform I/O or side effects.
 * Invariants:
 *   - Per WORKER_IS_DUMB: domain logic lives here, not in activities
 *   - All inputs/outputs are plain serializable objects
 *   - Formatting matches cogni-git-review markdown conventions
 *   - Routing-diagnostic wording mirrors docs/spec/node-ci-cd-contract.md
 *     § Single-Domain Scope > Diagnostic contract: name conflicting domains,
 *     name operator-territory paths, suggest the split, link the spec.
 * Side-effects: none
 * Links: task.0191, task.0410, docs/spec/temporal-patterns.md, docs/spec/node-ci-cd-contract.md
 * @internal
 */

import type {
  OwningNode,
  SuccessCriteria,
  ThresholdCriterion,
} from "@cogni/repo-spec";

// Relative path so each fork's PR comments link to its own spec copy.
// GitHub renders relative links in PR comments against the comment's own repo.
const SPEC_LINK = "docs/spec/node-ci-cd-contract.md#single-domain-scope";

// ---------------------------------------------------------------------------
// Types (serializable — used by workflow and activities)
// ---------------------------------------------------------------------------

export type GateStatus = "pass" | "fail" | "neutral";

export interface GateResult {
  readonly gateId: string;
  readonly gateType: string;
  readonly status: GateStatus;
  readonly summary: string;
  readonly metrics?: ReadonlyArray<{
    readonly metric: string;
    readonly score: number;
    readonly requirement?: string;
    readonly observation: string;
  }>;
}

export interface ReviewResult {
  readonly conclusion: GateStatus;
  readonly gateResults: readonly GateResult[];
  /**
   * COULD_NOT_EVALUATE_IS_NOT_NEUTRAL (story.5102): set when the run did not evaluate (graph
   * failed, no structured output, missing rule, uncited verdict, head moved). With
   * `fail_on_error: true` the conclusion is then `fail`, never `neutral`.
   */
  readonly couldNotEvaluate?: string;
}

export interface EvidenceBundle {
  readonly prNumber: number;
  readonly prTitle: string;
  readonly prBody: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly patches: ReadonlyArray<{
    readonly filename: string;
    readonly patch: string;
  }>;
  readonly totalDiffBytes: number;
}

/**
 * Structured output from the pr-review graph. `metrics`/`summary`/`insufficientEvidence` come
 * from the model (`evaluation-output` schema); `evidence`, `uncited` and `buildSha` are HOST
 * fields the graph's finalize node adds from the run's own tool results — never model-written.
 */
export interface EvaluationOutput {
  metrics: Array<{
    metric: string;
    value: number;
    observations: string[];
    /** Hub entry ids this metric's verdict rests on (VERDICT_CITES_WHAT_IT_READ). */
    citations?: string[];
  }>;
  summary: string;
  /** The model reports it lacked the evidence to judge. */
  insufficientEvidence?: boolean;
  /** Host: files read with content and hub/work entries whose bodies were returned this run. */
  evidence?: { files: string[]; entries: string[] };
  /** Host: a failing hub metric cited nothing the run read, or evidence was insufficient. */
  uncited?: boolean;
  /** Host: serving operator build that ran the graph. */
  buildSha?: string | null;
}

// ---------------------------------------------------------------------------
// Machine-readable check block (CHECK_IS_REQUEST_BOUND, story.5102)
// ---------------------------------------------------------------------------

/** Marker that precedes the one fenced JSON block at the end of a review check summary. */
export const REVIEW_RESULT_MARKER = "<!-- cogni-review-result v1 -->";

/** The machine-readable review block. Graders read ONLY this, never the prose. */
export interface ReviewResultBlock {
  readonly requestId: string;
  /** Serving operator build (stamped by the operator, not the worker). */
  readonly buildSha: string | null;
  readonly model: string;
  readonly conclusion: "success" | "failure" | "neutral";
  /** Set when the run could not evaluate; the reason code. */
  readonly couldNotEvaluate: string | null;
  /** Hub entry ids the model cited (union over metrics), unfiltered. */
  readonly citations: readonly string[];
  readonly evidence: {
    readonly files: readonly string[];
    readonly entries: readonly string[];
  };
}

/** Render the block that ends a check summary: marker + one fenced JSON object. */
export function formatReviewResultBlock(block: ReviewResultBlock): string {
  return `\n${REVIEW_RESULT_MARKER}\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`\n`;
}

/** Union of every metric's citations, in first-seen order. */
export function collectCitations(
  structured: EvaluationOutput | undefined
): string[] {
  const out = new Set<string>();
  for (const m of structured?.metrics ?? []) {
    for (const id of m.citations ?? []) {
      if (typeof id === "string" && id.length > 0) out.add(id);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// LLM Message Building (pure string concatenation)
// ---------------------------------------------------------------------------

/** Build the user message for a PR review evaluation. */
export function buildReviewUserMessage(params: {
  readonly prTitle: string;
  readonly prBody: string;
  readonly diffSummary: string;
  readonly evaluations: ReadonlyArray<{ metric: string; prompt: string }>;
}): string {
  const { prTitle, prBody, diffSummary, evaluations } = params;

  const metricsSection = evaluations
    .map((e, i) => `${i + 1}. **${e.metric}**: ${e.prompt}`)
    .join("\n");

  return `## Pull Request

**Title:** ${prTitle}
**Description:** ${prBody || "(no description)"}

## Code Changes

${diffSummary}

## Evaluation Criteria

Score each of the following metrics from 0.0 to 1.0:

${metricsSection}

Respond with your scores and observations for each metric.`;
}

// ---------------------------------------------------------------------------
// Criteria Evaluation (deterministic threshold comparison)
// ---------------------------------------------------------------------------

const OP_SYMBOLS: Record<string, string> = {
  gte: "\u2265",
  gt: ">",
  lte: "\u2264",
  lt: "<",
  eq: "=",
};

export function formatThreshold(
  threshold: ThresholdCriterion
): string | undefined {
  for (const op of Object.keys(OP_SYMBOLS)) {
    if (
      op in threshold &&
      typeof (threshold as Record<string, unknown>)[op] === "number"
    ) {
      const value = (threshold as Record<string, unknown>)[op] as number;
      return `${OP_SYMBOLS[op]} ${value.toFixed(2)}`;
    }
  }
  return undefined;
}

export function findRequirement(
  metricName: string,
  criteria: SuccessCriteria
): string | undefined {
  const reqMatch = (criteria.require ?? []).find(
    (t) => t.metric === metricName
  );
  if (reqMatch) {
    const formatted = formatThreshold(reqMatch);
    return formatted ? `${formatted} (all)` : undefined;
  }
  const anyMatch = (criteria.any_of ?? []).find((t) => t.metric === metricName);
  if (anyMatch) {
    const formatted = formatThreshold(anyMatch);
    return formatted ? `${formatted} (any)` : undefined;
  }
  return undefined;
}

export function evaluateCriteria(
  scores: ReadonlyMap<string, number>,
  criteria: SuccessCriteria
): GateStatus {
  const { require, any_of, neutral_on_missing_metrics } = criteria;

  if (require && require.length > 0) {
    for (const threshold of require) {
      const result = evaluateThreshold(
        scores,
        threshold,
        neutral_on_missing_metrics
      );
      if (result === "fail") return "fail";
      if (result === "neutral") return "neutral";
    }
  }

  if (any_of && any_of.length > 0) {
    let hasPass = false;
    let hasNeutral = false;
    for (const threshold of any_of) {
      const result = evaluateThreshold(
        scores,
        threshold,
        neutral_on_missing_metrics
      );
      if (result === "pass") {
        hasPass = true;
        break;
      }
      if (result === "neutral") hasNeutral = true;
    }
    if (!hasPass) {
      return hasNeutral ? "neutral" : "fail";
    }
  }

  return "pass";
}

function evaluateThreshold(
  scores: ReadonlyMap<string, number>,
  threshold: Record<string, unknown>,
  neutralOnMissing: boolean
): GateStatus {
  const metric = threshold.metric as string;
  const score = scores.get(metric);

  if (score === undefined) {
    return neutralOnMissing ? "neutral" : "fail";
  }

  if ("gte" in threshold && typeof threshold.gte === "number") {
    return score >= threshold.gte ? "pass" : "fail";
  }
  if ("gt" in threshold && typeof threshold.gt === "number") {
    return score > threshold.gt ? "pass" : "fail";
  }
  if ("lte" in threshold && typeof threshold.lte === "number") {
    return score <= threshold.lte ? "pass" : "fail";
  }
  if ("lt" in threshold && typeof threshold.lt === "number") {
    return score < threshold.lt ? "pass" : "fail";
  }
  if ("eq" in threshold && typeof threshold.eq === "number") {
    return Math.abs(score - threshold.eq) < 0.001 ? "pass" : "fail";
  }

  return "neutral";
}

export function aggregateGateStatuses(
  statuses: readonly GateStatus[]
): GateStatus {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "neutral")) return "neutral";
  return "pass";
}

// ---------------------------------------------------------------------------
// Markdown Formatting (pure string rendering)
// ---------------------------------------------------------------------------

function verdictLabel(status: GateStatus): string {
  switch (status) {
    case "pass":
      return "\u2705 PASS";
    case "fail":
      return "\u274C FAIL";
    default:
      return "\u26A0\uFE0F NEUTRAL";
  }
}

function statusEmoji(status: GateStatus): string {
  switch (status) {
    case "pass":
      return "\u2705";
    case "fail":
      return "\u274C";
    default:
      return "\u26A0\uFE0F";
  }
}

function countsLine(gates: readonly GateResult[]): string {
  const pass = gates.filter((g) => g.status === "pass").length;
  const fail = gates.filter((g) => g.status === "fail").length;
  const neutral = gates.filter((g) => g.status === "neutral").length;
  return `\u2705 ${pass} passed | \u274C ${fail} failed | \u26A0\uFE0F ${neutral} neutral`;
}

function sortedGates(gates: readonly GateResult[]): readonly GateResult[] {
  const order: Record<string, number> = { fail: 0, pass: 1, neutral: 2 };
  return [...gates].sort(
    (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)
  );
}

function formatGateSection(gate: GateResult): string {
  const lines: string[] = [];
  const emoji = statusEmoji(gate.status);

  lines.push(`### ${emoji} ${gate.gateId}\n`);
  lines.push(`${gate.summary}\n`);

  if (gate.metrics && gate.metrics.length > 0) {
    lines.push("| Metric | Score | Requirement | Observation |");
    lines.push("|--------|-------|-------------|-------------|");
    for (const m of gate.metrics) {
      const scoreBar = `${(m.score * 100).toFixed(0)}%`;
      const req = m.requirement ?? "\u2014";
      lines.push(
        `| ${m.metric} | ${scoreBar} | ${req} | ${m.observation.slice(0, 120)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatCheckRunSummary(
  result: ReviewResult,
  opts?: { daoBaseUrl?: string }
): string {
  const lines: string[] = [];

  if (opts?.daoBaseUrl && result.conclusion === "fail") {
    lines.push(`[Propose DAO Vote to Merge](${opts.daoBaseUrl})\n\n---\n`);
  }

  if (result.couldNotEvaluate) {
    lines.push(
      `**COULD NOT EVALUATE** \u2014 \`${result.couldNotEvaluate}\`. The review did not judge this PR; re-run it with POST /api/v1/vcs/review.\n`
    );
  }

  lines.push(`**${verdictLabel(result.conclusion)}**\n`);
  lines.push(countsLine(result.gateResults));
  lines.push("");

  for (const gate of sortedGates(result.gateResults)) {
    lines.push(formatGateSection(gate));
  }

  return lines.join("\n");
}

export function formatPrComment(
  result: ReviewResult,
  opts?: { headSha?: string; checkRunUrl?: string }
): string {
  const lines: string[] = [];

  lines.push(`## Cogni Review \u2014 ${verdictLabel(result.conclusion)}\n`);
  lines.push(`**Gates:** ${countsLine(result.gateResults)}\n`);

  const failed = result.gateResults.filter((g) => g.status === "fail");
  if (failed.length > 0) {
    lines.push("**Blockers:**");
    for (const gate of failed.slice(0, 3)) {
      lines.push(`- **${gate.gateId}**:`);
      if (gate.metrics && gate.metrics.length > 0) {
        lines.push("");
        lines.push("  | Metric | Score | Requirement | Observation |");
        lines.push("  |--------|-------|-------------|-------------|");
        for (const m of gate.metrics) {
          const req = m.requirement ?? "\u2014";
          lines.push(
            `  | ${m.metric} | ${m.score.toFixed(2)} | ${req} | ${m.observation.slice(0, 100)} |`
          );
        }
      } else {
        lines.push(`  - ${gate.summary}`);
      }
    }
    lines.push("");
  }

  if (opts?.checkRunUrl) {
    lines.push(`\n[View Details](${opts.checkRunUrl})`);
  }

  if (opts?.headSha) {
    lines.push(
      `\n<!-- cogni:summary v1 sha=${opts.headSha.slice(0, 7)} ts=${Date.now()} -->`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Routing diagnostics — formatters for cross-domain refusal + miss neutral.
// Wording mirrors docs/spec/node-ci-cd-contract.md § Single-Domain Scope >
// Diagnostic contract: name conflicting domains, name operator-territory
// paths, suggest the split, link the spec.
// ---------------------------------------------------------------------------

/**
 * Format the PR comment body for a cross-domain refusal.
 * Pure — no I/O, no time, no randomness, no path classification. Reads only
 * the resolver-labeled fields (`nodes`, `operatorPaths`, `operatorNodeId`)
 * on the OwningNode.
 */
export function formatCrossDomainRefusal(
  owningNode: Extract<OwningNode, { kind: "conflict" }>
): string {
  const domains = owningNode.nodes.map((n) => n.nodeId);
  const { operatorPaths, operatorNodeId } = owningNode;
  const operatorInvolved = operatorNodeId !== undefined;

  const lines: string[] = [];
  lines.push("## Cogni Review — Cross-Domain PR refused");
  lines.push("");
  lines.push(
    `This PR touches **${domains.length} domains**: \`${domains.join("` + `")}\`.`
  );
  lines.push("");
  lines.push(
    "Per the single-node-scope contract, each PR must own exactly one domain. The reviewer cannot apply per-node rules to a multi-domain change."
  );
  lines.push("");

  if (operatorInvolved && operatorPaths.length > 0) {
    lines.push("**Operator-territory paths in this PR:**");
    lines.push("");
    for (const p of operatorPaths.slice(0, 20)) {
      lines.push(`- \`${p}\``);
    }
    if (operatorPaths.length > 20) {
      lines.push(`- … and ${operatorPaths.length - 20} more`);
    }
    lines.push("");
  }

  lines.push("**How to resolve:**");
  lines.push("");
  if (operatorInvolved) {
    const others = domains.filter((d) => d !== operatorNodeId);
    lines.push(
      `1. File an operator PR with the operator-territory paths above.`
    );
    lines.push(`2. Rebase your \`${others.join("` + `")}\` change on it.`);
  } else {
    lines.push(
      `Split this PR into ${domains.length} separate PRs — one per domain (\`${domains.join("`, `")}\`).`
    );
  }
  lines.push("");
  lines.push(`See [single-node-scope spec](${SPEC_LINK}) for rationale.`);

  return lines.join("\n");
}

/**
 * Format the PR comment body for an unrecognized-scope (miss) outcome.
 * In practice this only fires on empty diffs — the operator domain catches
 * everything else by construction. Kept as a deliberate branch so the
 * workflow never silently passes an empty PR through the AI gate.
 */
export function formatNoScopeNeutral(): string {
  return [
    "## Cogni Review — No recognizable scope",
    "",
    "This PR has no changed files matching any registered domain. Skipping review.",
    "",
    `See [single-node-scope spec](${SPEC_LINK}).`,
  ].join("\n");
}
