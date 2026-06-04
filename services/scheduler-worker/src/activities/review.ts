// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/review`
 * Purpose: Temporal Activities for PR review — orchestration + domain evaluation.
 *   All GitHub I/O is HTTP-delegated to the operator's internal review API
 *   (bug.5000); this module holds no GitHub SDK and no App private key.
 * Scope: Activities call the operator review plane (ReviewHttpClient) for GitHub
 *   reads/writes and run the pure domain evaluation (criteria, formatting) locally.
 * Invariants:
 *   - WORKER_HOLDS_NO_GITHUB_CRED: no Octokit, no App key. Every GitHub call
 *     routes to the operator via ReviewHttpClient + SCHEDULER_API_TOKEN.
 *   - Per EXECUTION_VIA_SERVICE_API: the worker delegates I/O; it does not call
 *     GitHub directly (mirrors the graph path's run-http delegation).
 *   - Per ACTIVITY_IDEMPOTENCY: GitHub writes use stable business keys (repo/pr/headSha).
 *   - Per PER_NODE_RULE_LOADING: owning-domain resolution + rule fetch happen on
 *     the operator (which holds the GitHub plane). The worker re-emits the
 *     structured `review.routed` log for the deploy_verified loop.
 *   - `postRoutingDiagnosticActivity` handles `conflict` + `miss` with a pure
 *     formatter + neutral check run — no AI tokens, no GraphRunWorkflow child.
 *   - Domain logic (criteria evaluation, formatting) in domain/review.ts, not here.
 * Side-effects: IO (HTTP to operator review plane)
 * Links: bug.5000, task.0191, task.0410, task.0280, docs/spec/unified-graph-launch.md,
 *   services/scheduler-worker/src/adapters/review-http.ts
 * @internal
 */

import type {
  InternalReviewPrContextOutput,
  ReviewCheckRunConclusion,
} from "@cogni/node-contracts";
import {
  extractDaoConfig,
  type OwningNode,
  parseRepoSpec,
  type Rule,
} from "@cogni/repo-spec";
import type { GraphRunResult } from "@cogni/temporal-workflows";
import {
  aggregateGateStatuses,
  type EvaluationOutput,
  type EvidenceBundle,
  evaluateCriteria,
  findRequirement,
  formatCheckRunSummary,
  formatCrossDomainRefusal,
  formatNoScopeNeutral,
  formatPrComment,
  type GateResult,
  type GateStatus,
  type ReviewResult,
} from "@cogni/temporal-workflows";
import type { Logger } from "../observability/logger.js";
import type { ReviewHttpClient } from "../ports/index.js";
import { translateHttpError } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewActivityDeps {
  /** HTTP client for the operator's internal review GitHub plane. */
  reviewClient: ReviewHttpClient;
  logger: Logger;
}

export interface CreateCheckRunInput {
  owner: string;
  repo: string;
  headSha: string;
  installationId: number;
}

export interface FetchPrContextInput {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
}

export interface PostRoutingDiagnosticInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId: number;
  checkRunId?: number;
  owningNode: OwningNode;
  changedFiles: readonly string[];
}

export interface PostReviewResultInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId: number;
  checkRunId?: number;
  // When no gates configured — simple pass
  noGatesConfigured?: boolean;
  conclusion?: GateStatus;
  gateResults?: readonly GateResult[];
  // When graph ran — full evaluation
  graphResult?: GraphRunResult;
  gatesConfig?: { gates: unknown[]; failOnError: boolean };
  rules?: Record<string, Rule>;
  evidence?: EvidenceBundle;
  /** Raw repo-spec YAML for DAO config extraction */
  repoSpecYaml?: string;
}

// ---------------------------------------------------------------------------
// Activity factory
// ---------------------------------------------------------------------------

export function createReviewActivities(deps: ReviewActivityDeps) {
  const { reviewClient, logger } = deps;

  /** Create a GitHub Check Run in "in_progress" state (via operator plane). */
  async function createCheckRunActivity(
    input: CreateCheckRunInput
  ): Promise<number> {
    try {
      return await reviewClient.createCheckRun({
        owner: input.owner,
        repo: input.repo,
        headSha: input.headSha,
        installationId: input.installationId,
      });
    } catch (err) {
      // Mirror run-http: permanent 4xx → nonRetryable; transient/5xx bubble.
      translateHttpError(err, "createCheckRunActivity");
    }
  }

  /** Fetch PR evidence, repo-spec, and rules from the operator review plane. */
  async function fetchPrContextActivity(
    input: FetchPrContextInput
  ): Promise<InternalReviewPrContextOutput> {
    let context: InternalReviewPrContextOutput;
    try {
      context = await reviewClient.fetchPrContext({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        installationId: input.installationId,
      });
    } catch (err) {
      translateHttpError(err, "fetchPrContextActivity");
    }

    const { owningNode } = context;
    logger.info(
      {
        owningNodeKind: owningNode.kind,
        owningNodeId:
          owningNode.kind === "single" ? owningNode.nodeId : undefined,
        owningNodePath:
          owningNode.kind === "single" ? owningNode.path : undefined,
        conflictNodeIds:
          owningNode.kind === "conflict"
            ? owningNode.nodes.map((n) => n.nodeId)
            : undefined,
        changedFileCount: context.changedFiles.length,
        prNumber: input.prNumber,
        headSha: context.evidence.headSha,
      },
      "review.routed"
    );

    return context;
  }

  /** Evaluate graph results, format markdown, and post via the operator plane. */
  async function postReviewResultActivity(
    input: PostReviewResultInput
  ): Promise<void> {
    let conclusion: GateStatus;
    let gateResults: readonly GateResult[];

    if (input.noGatesConfigured) {
      conclusion = "pass";
      gateResults = [];
    } else if (input.graphResult && input.gatesConfig && input.rules) {
      const evaluated = evaluateGraphResult(
        input.graphResult,
        input.gatesConfig,
        input.rules,
        input.evidence
      );
      conclusion = evaluated.conclusion;
      gateResults = evaluated.gateResults;
    } else {
      conclusion = input.conclusion ?? "neutral";
      gateResults = input.gateResults ?? [];
    }

    const reviewResult: ReviewResult = { conclusion, gateResults };

    // Build DAO deep link from repo-spec (for Check Run "View Details" page)
    let daoBaseUrl: string | undefined;
    if (input.repoSpecYaml) {
      try {
        const spec = parseRepoSpec(input.repoSpecYaml);
        const dao = extractDaoConfig(spec);
        if (dao) {
          const url = new URL("/propose/merge", dao.base_url);
          url.searchParams.set("dao", dao.dao_contract);
          url.searchParams.set("plugin", dao.plugin_contract);
          url.searchParams.set("signal", dao.signal_contract);
          url.searchParams.set("chainId", dao.chain_id);
          url.searchParams.set("action", "merge");
          url.searchParams.set("target", "change");
          url.searchParams.set("resource", String(input.prNumber));
          url.searchParams.set("vcs", "github");
          url.searchParams.set(
            "repoUrl",
            `https://github.com/${input.owner}/${input.repo}`
          );
          daoBaseUrl = url.toString();
        }
      } catch {
        // Best-effort — no DAO link if parsing fails
      }
    }

    const checkRunSummary = formatCheckRunSummary(reviewResult, { daoBaseUrl });

    const checkRunUrl = input.checkRunId
      ? `https://github.com/${input.owner}/${input.repo}/runs/${input.checkRunId}`
      : undefined;

    const prCommentBody = formatPrComment(reviewResult, {
      headSha: input.headSha,
      checkRunUrl,
    });

    // Finalize check run (if we have one)
    if (input.checkRunId) {
      try {
        await reviewClient.updateCheckRun({
          owner: input.owner,
          repo: input.repo,
          installationId: input.installationId,
          checkRunId: input.checkRunId,
          conclusion: mapConclusion(conclusion),
          title: `PR Review: ${conclusion.toUpperCase()}`,
          summary: checkRunSummary,
        });
      } catch (error) {
        logger.warn(
          { checkRunId: input.checkRunId, error: String(error) },
          "Failed to update check run"
        );
      }
    }

    // Post PR comment — operator applies the head-SHA staleness guard.
    let result: Awaited<ReturnType<ReviewHttpClient["postPrComment"]>>;
    try {
      result = await reviewClient.postPrComment({
        owner: input.owner,
        repo: input.repo,
        installationId: input.installationId,
        prNumber: input.prNumber,
        body: prCommentBody,
        expectedHeadSha: input.headSha,
      });
    } catch (err) {
      translateHttpError(err, "postReviewResultActivity");
    }
    if (!result.posted) {
      logger.info(
        {
          prNumber: input.prNumber,
          expectedSha: input.headSha,
          reason: result.reason,
        },
        "PR updated during review — comment skipped"
      );
    }
  }

  /**
   * Post a routing diagnostic for `conflict` (cross-domain) or `miss` (no scope) PRs.
   * Posts a PR comment via pure formatter + finalizes the check run as `neutral`.
   * No GraphRunWorkflow child, no LLM call, no gate evaluation.
   */
  async function postRoutingDiagnosticActivity(
    input: PostRoutingDiagnosticInput
  ): Promise<void> {
    let body: string;
    let title: string;
    if (input.owningNode.kind === "conflict") {
      body = formatCrossDomainRefusal(input.owningNode);
      title = "Cross-domain PR refused";
    } else {
      // kind === "miss" — empty diff or no parsable spec.
      body = formatNoScopeNeutral();
      title = "No recognizable scope";
    }

    if (input.checkRunId) {
      try {
        await reviewClient.updateCheckRun({
          owner: input.owner,
          repo: input.repo,
          installationId: input.installationId,
          checkRunId: input.checkRunId,
          conclusion: "neutral",
          title: `PR Review: ${title}`,
          summary: body,
        });
      } catch (error) {
        logger.warn(
          { checkRunId: input.checkRunId, error: String(error) },
          "Failed to update check run for routing diagnostic"
        );
      }
    }

    try {
      await reviewClient.postPrComment({
        owner: input.owner,
        repo: input.repo,
        installationId: input.installationId,
        prNumber: input.prNumber,
        body,
      });
    } catch (error) {
      logger.warn(
        { prNumber: input.prNumber, error: String(error) },
        "Failed to post routing diagnostic comment"
      );
    }
  }

  return {
    createCheckRunActivity,
    fetchPrContextActivity,
    postReviewResultActivity,
    postRoutingDiagnosticActivity,
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure domain evaluation — no I/O)
// ---------------------------------------------------------------------------

/**
 * Gate shape as it arrives from the operator pr-context plane. Mirrors
 * @cogni/repo-spec GateConfig; kept local so this module needs no repo-spec
 * zod3 runtime coupling.
 */
type GateLike = {
  type: string;
  id?: string;
  with?: Record<string, unknown>;
};

/**
 * Evaluate graph structured output against all gate criteria.
 * Domain logic from domain/review.ts — bridges graph output to gate results.
 */
function evaluateGraphResult(
  graphResult: GraphRunResult,
  gatesConfig: { gates: unknown[]; failOnError: boolean },
  rules: Record<string, Rule>,
  evidence?: EvidenceBundle
): ReviewResult {
  const gateResults: GateResult[] = [];

  for (const rawGate of gatesConfig.gates) {
    const gate = rawGate as GateLike;
    if (gate.type === "review-limits") {
      gateResults.push(evaluateReviewLimitsGate(gate, evidence));
    } else if (gate.type === "ai-rule") {
      const ruleFile = gate.with?.rule_file as string | undefined;
      const rule = ruleFile ? rules[ruleFile] : undefined;
      if (!rule || !graphResult.ok || !graphResult.structuredOutput) {
        gateResults.push({
          gateId: rule?.id ?? gate.type,
          gateType: "ai-rule",
          status: "neutral",
          summary: graphResult.ok
            ? "No structured output from graph"
            : `Graph execution failed`,
        });
        continue;
      }

      const structured = graphResult.structuredOutput as EvaluationOutput;
      const evaluations = rule.evaluations.map((entry) => {
        const entries = Object.entries(entry);
        return entries[0] as [string, string];
      });
      const metricNames = evaluations.map(([name]) => name);

      const scores = new Map<string, number>();
      const metrics: Array<{
        metric: string;
        score: number;
        requirement?: string;
        observation: string;
      }> = [];

      if (structured?.metrics) {
        for (const entry of structured.metrics) {
          if (metricNames.includes(entry.metric)) {
            scores.set(entry.metric, entry.value);
            const req = findRequirement(entry.metric, rule.success_criteria);
            metrics.push({
              metric: entry.metric,
              score: entry.value,
              ...(req != null ? { requirement: req } : {}),
              observation: entry.observations.join("; "),
            });
          }
        }
      }

      const status = evaluateCriteria(scores, rule.success_criteria);
      gateResults.push({
        gateId: rule.id,
        gateType: "ai-rule",
        status,
        summary:
          status === "pass"
            ? `Rule "${rule.id}" passed`
            : status === "fail"
              ? `Rule "${rule.id}" failed threshold checks`
              : `Rule "${rule.id}" neutral`,
        metrics,
      });
    }
  }

  const conclusion = aggregateGateStatuses(gateResults.map((r) => r.status));
  return { conclusion, gateResults };
}

/** Evaluate review-limits gate (pure deterministic, no LLM). */
function evaluateReviewLimitsGate(
  gate: GateLike,
  evidence?: EvidenceBundle
): GateResult {
  const gateId = gate.id ?? "review-limits";
  if (!evidence) {
    return {
      gateId,
      gateType: "review-limits",
      status: "neutral",
      summary: "No evidence available",
    };
  }

  const limits = gate.with as
    | { max_changed_files?: number; max_total_diff_kb?: number }
    | undefined;

  let status: GateStatus = "pass";
  const reasons: string[] = [];

  if (
    limits?.max_changed_files !== undefined &&
    evidence.changedFiles > limits.max_changed_files
  ) {
    status = "fail";
    reasons.push(
      `Changed files (${evidence.changedFiles}) exceeds limit (${limits.max_changed_files})`
    );
  }
  if (
    limits?.max_total_diff_kb !== undefined &&
    evidence.totalDiffBytes / 1024 > limits.max_total_diff_kb
  ) {
    status = "fail";
    reasons.push(
      `Total diff (${Math.round(evidence.totalDiffBytes / 1024)}KB) exceeds limit (${limits.max_total_diff_kb}KB)`
    );
  }

  return {
    gateId,
    gateType: "review-limits",
    status,
    summary: reasons.length > 0 ? reasons.join("; ") : "Within limits",
  };
}

function mapConclusion(status: string): ReviewCheckRunConclusion {
  switch (status) {
    case "pass":
      return "success";
    case "fail":
      return "failure";
    default:
      return "neutral";
  }
}

/** Export type for proxyActivities<ReviewActivities>() in workflows. */
export type ReviewActivities = ReturnType<typeof createReviewActivities>;
