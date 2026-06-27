// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/services/review-handler`
 * Purpose: Orchestrate the full PR review flow: evidence → gates → check run → comment.
 * Scope: Top-level review handler called from facade. Does not import adapters or bootstrap.
 * Invariants: Fire-and-forget — errors logged, never block webhook response. System tenant billing.
 *   ARCHITECTURE_ALIGNMENT — deps injected, no adapter imports.
 * Side-effects: IO (GitHub API via injected deps, LLM via graph executor)
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { EVENT_NAMES, logEvent } from "@cogni/node-shared";
import { extractDaoConfig, parseRepoSpec } from "@cogni/repo-spec";
import type { Logger } from "pino";
import type { GraphExecutorPort } from "@/ports";

import { runGates } from "../gate-orchestrator";
import {
  formatCheckRunSummary,
  formatCrossDomainRefusal,
  formatNoScopeNeutral,
  formatPrComment,
} from "../summary-formatter";
import type { ReviewContext, ReviewRunContext } from "../types";

/**
 * Dependencies for the review handler.
 * Adapter functions are injected by the facade — feature layer never imports adapters.
 */
export interface ReviewHandlerDeps {
  readonly executor: GraphExecutorPort;
  readonly log: Logger;
  /** System tenant's default virtual key ID (looked up from DB). */
  readonly virtualKeyId: string;

  // --- Injected adapter functions (facade provides concrete implementations) ---

  readonly createCheckRun: (
    owner: string,
    repo: string,
    headSha: string
  ) => Promise<number>;
  readonly updateCheckRun: (
    owner: string,
    repo: string,
    checkRunId: number,
    conclusion: string,
    summary: string
  ) => Promise<void>;
  readonly loadReviewContext: (
    owner: string,
    repo: string,
    prNumber: number,
    installationId: number
  ) => Promise<ReviewRunContext>;
  readonly postPrComment: (
    owner: string,
    repo: string,
    prNumber: number,
    expectedHeadSha: string,
    body: string
  ) => Promise<boolean>;
}

/**
 * Run a full PR review.
 * Called as fire-and-forget from the facade/webhook route.
 */
export async function handlePrReview(
  ctx: ReviewContext,
  deps: ReviewHandlerDeps
): Promise<void> {
  const { owner, repo, prNumber, headSha } = ctx;
  const reqId = randomUUID();
  const log = deps.log.child({
    component: "pr-review",
    owner,
    repo,
    prNumber,
    headSha,
    reqId,
  });
  const start = performance.now();

  let checkRunId: number | undefined;

  try {
    // 1. Gather evidence + node-owned review config from the target repo.
    const reviewContext = await deps.loadReviewContext(
      owner,
      repo,
      prNumber,
      ctx.installationId
    );
    const { evidence, gatesConfig, owningNode } = reviewContext;

    // Repos opt into review by declaring gates. No gates means no Check Run,
    // no comment, and no graph execution, even when routing cannot resolve a
    // node. Disabled review must be invisible to developers.
    if (gatesConfig.gates.length === 0) {
      logEvent(log, EVENT_NAMES.REVIEW_COMPLETE, {
        reqId,
        outcome: "skipped",
        conclusion: "neutral",
        gateCount: 0,
        changedFiles: evidence.changedFiles,
        owningNodeKind: owningNode.kind,
        durationMs: Math.round(performance.now() - start),
      });
      return;
    }

    // 2. Create Check Run (in_progress) only after review is known to be on.
    try {
      checkRunId = await deps.createCheckRun(owner, repo, headSha);
    } catch {
      logEvent(log, EVENT_NAMES.ADAPTER_GITHUB_REVIEW_ERROR, {
        reqId,
        dep: "github",
        reasonCode: "check_run_create_failed",
        durationMs: Math.round(performance.now() - start),
      });
      // Continue without check run
    }

    // Routing diagnostics report only after review is explicitly enabled.
    if (owningNode.kind !== "single") {
      const body =
        owningNode.kind === "conflict"
          ? formatCrossDomainRefusal(owningNode)
          : formatNoScopeNeutral();
      if (checkRunId) {
        await deps.updateCheckRun(owner, repo, checkRunId, "neutral", body);
      }
      await deps.postPrComment(owner, repo, prNumber, headSha, body);
      logEvent(log, EVENT_NAMES.REVIEW_COMPLETE, {
        reqId,
        outcome: "success",
        conclusion: "neutral",
        gateCount: 0,
        changedFiles: evidence.changedFiles,
        durationMs: Math.round(performance.now() - start),
      });
      return;
    }

    // 3. Rule loader
    const loadRule = (ruleFile: string) => {
      const rule = reviewContext.rules[ruleFile];
      if (!rule) {
        throw new Error(`Missing rule file: ${ruleFile}`);
      }
      return rule;
    };

    // 4. Run gate orchestrator
    const result = await runGates(gatesConfig.gates, evidence, {
      executor: deps.executor,
      log,
      loadRule,
    });

    // 5. Build DAO deep link (for Check Run "View Details" page)
    const daoBaseUrl = (() => {
      if (!reviewContext.repoSpecYaml) return undefined;
      let repoSpec: ReturnType<typeof parseRepoSpec>;
      try {
        repoSpec = parseRepoSpec(reviewContext.repoSpecYaml);
      } catch {
        return undefined;
      }
      const dao = extractDaoConfig(repoSpec);
      if (!dao?.base_url) return undefined;

      try {
        const url = new URL("/propose/merge", dao.base_url);
        url.searchParams.set("dao", dao.dao_contract);
        url.searchParams.set("plugin", dao.plugin_contract);
        url.searchParams.set("signal", dao.signal_contract);
        url.searchParams.set("chainId", dao.chain_id);
        url.searchParams.set("action", "merge");
        url.searchParams.set("target", "change");
        url.searchParams.set("pr", String(prNumber));
        url.searchParams.set("repoUrl", `https://github.com/${owner}/${repo}`);
        return url.toString();
      } catch {
        return dao.base_url;
      }
    })();

    // 6. Update Check Run (with proposal link on View Details page)
    if (checkRunId) {
      const summary = formatCheckRunSummary(result, {
        ...(daoBaseUrl !== undefined && { daoBaseUrl }),
      });
      await deps.updateCheckRun(
        owner,
        repo,
        checkRunId,
        result.conclusion,
        summary
      );
    }

    // 7. Post PR Comment (with staleness guard)
    const checkRunUrl = checkRunId
      ? `https://github.com/${owner}/${repo}/runs/${checkRunId}`
      : undefined;

    const commentBody = formatPrComment(result, {
      headSha,
      ...(checkRunUrl !== undefined && { checkRunUrl }),
    });
    const posted = await deps.postPrComment(
      owner,
      repo,
      prNumber,
      headSha,
      commentBody
    );

    const durationMs = Math.round(performance.now() - start);
    logEvent(log, EVENT_NAMES.REVIEW_COMPLETE, {
      reqId,
      outcome: "success",
      conclusion: result.conclusion,
      gateCount: result.gateResults.length,
      changedFiles: evidence.changedFiles,
      commentPosted: posted,
      durationMs,
    });
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    logEvent(log, EVENT_NAMES.REVIEW_COMPLETE, {
      reqId,
      outcome: "error",
      errorCode: "review_failed",
      durationMs,
    });

    // Update check run to neutral if possible
    if (checkRunId) {
      try {
        await deps.updateCheckRun(
          owner,
          repo,
          checkRunId,
          "neutral",
          `Review encountered an error: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
        // Best-effort — don't throw from error handler
      }
    }
  }
}
