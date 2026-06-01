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
import type { Rule } from "@cogni/repo-spec";
import {
  extractDaoConfig,
  extractGatesConfig,
  parseRepoSpec,
  parseRule,
} from "@cogni/repo-spec";
import type { Logger } from "pino";
import type { GraphExecutorPort } from "@/ports";

import { runGates } from "../gate-orchestrator";
import { formatCheckRunSummary, formatPrComment } from "../summary-formatter";
import type { EvidenceBundle, ReviewContext } from "../types";

/** Default model for PR review. */
const DEFAULT_REVIEW_MODEL = "gpt-4o-mini";

/**
 * Dependencies for the review handler.
 * Adapter functions are injected by the facade — feature layer never imports adapters.
 */
export interface ReviewHandlerDeps {
  readonly executor: GraphExecutorPort;
  readonly log: Logger;
  /** System tenant's default virtual key ID (looked up from DB). */
  readonly virtualKeyId: string;
  readonly reviewModel?: string;

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
  readonly gatherEvidence: (
    owner: string,
    repo: string,
    prNumber: number
  ) => Promise<EvidenceBundle>;
  readonly postPrComment: (
    owner: string,
    repo: string,
    prNumber: number,
    expectedHeadSha: string,
    body: string
  ) => Promise<boolean>;
  readonly readRepoSpec: () => string;
  readonly readRuleFile: (ruleFile: string) => string;
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

  // 1. Create Check Run (in_progress)
  let checkRunId: number | undefined;
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

  try {
    // 2. Gather evidence
    const evidence = await deps.gatherEvidence(owner, repo, prNumber);

    // 3. Load gates config from local repo-spec
    const repoSpecYaml = deps.readRepoSpec();
    const repoSpec = parseRepoSpec(repoSpecYaml);
    const gatesConfig = extractGatesConfig(repoSpec);

    if (gatesConfig.gates.length === 0) {
      if (checkRunId) {
        await deps.updateCheckRun(
          owner,
          repo,
          checkRunId,
          "pass",
          "No review gates configured."
        );
      }
      logEvent(log, EVENT_NAMES.REVIEW_COMPLETE, {
        reqId,
        outcome: "success",
        conclusion: "pass",
        gateCount: 0,
        changedFiles: evidence.changedFiles,
        durationMs: Math.round(performance.now() - start),
      });
      return;
    }

    // 4. Build run identity
    const model = deps.reviewModel ?? DEFAULT_REVIEW_MODEL;

    // 5. Rule loader
    const ruleCache = new Map<string, Rule>();
    const loadRule = (ruleFile: string): Rule => {
      let rule = ruleCache.get(ruleFile);
      if (!rule) {
        const ruleYaml = deps.readRuleFile(ruleFile);
        rule = parseRule(ruleYaml);
        ruleCache.set(ruleFile, rule);
      }
      return rule;
    };

    // 6. Run gate orchestrator
    const result = await runGates(gatesConfig.gates, evidence, {
      executor: deps.executor,
      model,
      log,
      loadRule,
    });

    // 7. Build DAO deep link (for Check Run "View Details" page)
    const daoBaseUrl = (() => {
      const dao = extractDaoConfig(repoSpec);
      if (!dao) return undefined;

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

    // 8. Update Check Run (with proposal link on View Details page)
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

    // 9. Post PR Comment (with staleness guard)
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
