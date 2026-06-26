// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/github-review`
 * Purpose: Operator-owned GitHub plane for PR review — create/finalize check runs,
 *   post PR comments, and build the full review context (PR reads + repo-spec
 *   orchestration). The scheduler-worker's review activities HTTP-delegate here
 *   so the worker holds no GitHub credential (bug.5000).
 * Scope: All GitHub I/O (Octokit) + repo-spec parsing for review live here. Thin
 *   internal routes call these methods; the GitHub App private key never leaves
 *   the operator.
 * Invariants:
 *   - AUTH_VIA_APP: installation token via createInstallationOctokit (JWT exchange).
 *   - TOKEN_SHORT_LIVED: tokens are never persisted.
 *   - Owning-domain resolution mirrors the CI single-node-scope gate; `conflict`
 *     and `miss` short-circuit upstream in the workflow.
 * Side-effects: IO (GitHub REST API)
 * Links: bug.5000, docs/spec/node-ci-cd-contract.md#single-domain-scope,
 *   services/scheduler-worker/src/adapters/review-http.ts, github-auth.ts
 * @internal
 */

import type {
  InternalReviewCreateCheckRunInput,
  InternalReviewPostPrCommentInput,
  InternalReviewPostPrCommentOutput,
  InternalReviewPrContextInput,
  InternalReviewUpdateCheckRunInput,
} from "@cogni/node-contracts";
import {
  extractGatesConfig,
  extractOwningNode,
  extractReviewConfig,
  type GateConfig,
  type GatesConfig,
  type OwningNode,
  parseRepoSpec,
  parseRule,
  type RepoSpec,
  type Rule,
  resolveRulePath,
} from "@cogni/repo-spec";
import {
  buildReviewUserMessage,
  type EvidenceBundle,
} from "@cogni/temporal-workflows";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createInstallationOctokit } from "./github-auth";

// ---------------------------------------------------------------------------
// Constants (ported from the former worker review activity)
// ---------------------------------------------------------------------------

const CHECK_RUN_NAME = "Cogni Git PR Review";
const DEFAULT_REVIEW_MODELREF = {
  providerKey: "platform",
  modelId: "gpt-4o-mini",
} as const;
const MAX_PATCH_BYTES_PER_FILE = 100_000;
const MAX_TOTAL_PATCH_BYTES = 500_000;
const MAX_FILES_WITH_PATCHES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GithubReviewAdapterDeps {
  /** GitHub App ID (GH_REVIEW_APP_ID). */
  appId: string;
  /** Base64-encoded PEM private key (GH_REVIEW_APP_PRIVATE_KEY_BASE64). */
  privateKeyBase64: string;
  logger: Logger;
}

/** Full review context returned to the worker. JSON-serializable. */
export interface PrReviewContext {
  evidence: EvidenceBundle;
  /** Whether this node opts into PR review (repo-spec `review.enabled`, default true). */
  reviewEnabled: boolean;
  gatesConfig: GatesConfig;
  rules: Record<string, Rule>;
  graphMessages: Array<{ role: string; content: string }>;
  responseFormat: { prompt: string; schemaId: string };
  modelRef: { providerKey: string; modelId: string; connectionId?: string };
  repoSpecYaml?: string;
  changedFiles: string[];
  owningNode: OwningNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a file from a GitHub repo as raw text. Handles raw + base64 responses. */
async function fetchRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner,
      repo,
      path,
      ref,
      headers: { accept: "application/vnd.github.raw+json" },
    }
  );
  return typeof response.data === "string"
    ? response.data
    : Buffer.from(
        (response.data as { content?: string }).content ?? "",
        "base64"
      ).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createGithubReviewAdapter(deps: GithubReviewAdapterDeps) {
  const { appId, privateKeyBase64, logger } = deps;

  function octokitFor(installationId: number): Octokit {
    return createInstallationOctokit(installationId, appId, privateKeyBase64);
  }

  /** Create a Check Run in "in_progress" state. Returns its id. */
  async function createCheckRun(
    target: InternalReviewCreateCheckRunInput
  ): Promise<number> {
    const octokit = octokitFor(target.installationId);
    const response = await octokit.request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        owner: target.owner,
        repo: target.repo,
        name: CHECK_RUN_NAME,
        head_sha: target.headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      }
    );
    return response.data.id;
  }

  /** Finalize a Check Run with a conclusion + formatted output. */
  async function updateCheckRun(
    target: InternalReviewUpdateCheckRunInput
  ): Promise<void> {
    const octokit = octokitFor(target.installationId);
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      {
        owner: target.owner,
        repo: target.repo,
        check_run_id: target.checkRunId,
        status: "completed",
        conclusion: target.conclusion,
        completed_at: new Date().toISOString(),
        output: { title: target.title, summary: target.summary },
      }
    );
  }

  /**
   * Post an issue comment on a PR. When `expectedHeadSha` is set, re-reads the
   * PR head and skips the comment if it has moved (staleness guard).
   */
  async function postPrComment(
    target: InternalReviewPostPrCommentInput
  ): Promise<InternalReviewPostPrCommentOutput> {
    const octokit = octokitFor(target.installationId);

    if (target.expectedHeadSha) {
      const prResponse = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: target.owner,
          repo: target.repo,
          pull_number: target.prNumber,
        }
      );
      const currentSha = prResponse.data.head.sha;
      if (currentSha !== target.expectedHeadSha) {
        logger.info(
          {
            prNumber: target.prNumber,
            expectedSha: target.expectedHeadSha,
            currentSha,
          },
          "PR updated during review — skipping comment"
        );
        return { posted: false, reason: "stale" };
      }
    }

    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: target.owner,
        repo: target.repo,
        issue_number: target.prNumber,
        body: target.body,
      }
    );
    return { posted: true };
  }

  /** Fetch PR evidence, repo-spec, rules, and resolve the owning domain. */
  async function fetchPrContext(
    target: InternalReviewPrContextInput
  ): Promise<PrReviewContext> {
    const octokit = octokitFor(target.installationId);
    const { owner, repo, prNumber } = target;

    const [prResponse, filesResponse] = await Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
      }),
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    ]);

    const pr = prResponse.data;
    const files = filesResponse.data;

    let totalDiffBytes = 0;
    for (const file of files) {
      totalDiffBytes += file.patch?.length ?? 0;
    }

    const patches: Array<{ filename: string; patch: string }> = [];
    let usedBytes = 0;
    for (const file of files.slice(0, MAX_FILES_WITH_PATCHES)) {
      if (!file.patch) continue;
      let patch = file.patch;
      if (patch.length > MAX_PATCH_BYTES_PER_FILE) {
        patch = `${patch.slice(0, MAX_PATCH_BYTES_PER_FILE)}\n... (truncated)`;
      }
      if (usedBytes + patch.length > MAX_TOTAL_PATCH_BYTES) {
        patches.push({
          filename: file.filename,
          patch: "... (budget exceeded, patch omitted)",
        });
        continue;
      }
      usedBytes += patch.length;
      patches.push({ filename: file.filename, patch });
    }

    const evidence: EvidenceBundle = {
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      patches,
      totalDiffBytes,
    };

    const changedFiles = files.map((f) => f.filename);

    // Fetch repo-spec from target repo (base branch)
    let repoSpecYaml: string;
    try {
      repoSpecYaml = await fetchRepoFile(
        octokit,
        owner,
        repo,
        ".cogni/repo-spec.yaml",
        pr.base.ref
      );
    } catch {
      // No repo-spec — empty gates; routing no-ops (miss).
      return {
        evidence,
        reviewEnabled: true,
        gatesConfig: { gates: [], failOnError: false },
        rules: {},
        graphMessages: [],
        responseFormat: { prompt: "", schemaId: "" },
        modelRef: DEFAULT_REVIEW_MODELREF,
        changedFiles,
        owningNode: { kind: "miss" },
      };
    }

    // Parse leniently — target repo may not have full node_id/scope_id fields.
    let gatesConfig: GatesConfig;
    let parsedSpec: RepoSpec | null = null;
    // Review on/off + model is node-controlled via repo-spec `review:` block.
    // Default: enabled, operator default model (backward-compat with always-on).
    let reviewEnabled = true;
    let modelRef: PrReviewContext["modelRef"] = DEFAULT_REVIEW_MODELREF;
    try {
      parsedSpec = parseRepoSpec(repoSpecYaml);
      gatesConfig = extractGatesConfig(parsedSpec);
      const reviewConfig = extractReviewConfig(parsedSpec);
      reviewEnabled = reviewConfig.enabled;
      if (reviewConfig.model) {
        modelRef = { providerKey: "platform", modelId: reviewConfig.model };
      }
    } catch {
      const raw = parseYaml(repoSpecYaml) as Record<string, unknown>;
      const gates = Array.isArray(raw.gates) ? raw.gates : [];
      gatesConfig = {
        gates: gates as GateConfig[],
        failOnError: raw.fail_on_error === true,
      };
      // Mirror the typed path for repos whose spec fails strict parse.
      const review = (raw.review ?? {}) as {
        enabled?: unknown;
        model?: unknown;
      };
      reviewEnabled = review.enabled !== false;
      if (typeof review.model === "string" && review.model.length > 0) {
        modelRef = { providerKey: "platform", modelId: review.model };
      }
    }

    // Owning-domain resolution. The structured `review.routed` log is emitted by
    // the worker activity (the orchestrator's observability for the
    // deploy_verified loop), not here — see services/scheduler-worker review.ts.
    //
    // `extractOwningNode` is monorepo-shaped: it routes changed files across the root
    // `nodes:` registry and enforces the meta-test invariant that operator is registered.
    // The review app also runs against FOREIGN repos:
    //   - Single-node fork (no `nodes:` registry): the whole repo IS one node. Resolve to
    //     `single { node_id, "." }` so the review runs against the fork's own gates +
    //     repo-root `.cogni/rules`, instead of throwing the monorepo invariant (→ 500).
    //   - Populated registry missing operator: can't route a foreign multi-node repo →
    //     degrade to `miss` (skip) rather than 500. The operator's OWN monorepo always
    //     carries the operator entry (meta-test invariant); CI hard-fails real drift.
    const ROOT_NODE_PATH = ".";
    let owningNode: OwningNode = { kind: "miss" };
    if (parsedSpec) {
      const registry = parsedSpec.nodes ?? [];
      if (registry.length === 0) {
        owningNode = {
          kind: "single",
          nodeId: parsedSpec.node_id,
          path: ROOT_NODE_PATH,
        };
      } else {
        try {
          owningNode = extractOwningNode(parsedSpec, changedFiles);
        } catch (error) {
          logger.warn(
            { owner, repo, error: String(error) },
            "review.owning-node unresolved (registry lacks operator entry); skipping scope"
          );
        }
      }
    }

    // Single-node forks review against repo-root `.cogni/rules`; monorepo nodes use
    // their per-node rule dir. `resolveRulePath` would emit `./.cogni/rules` for the
    // root sentinel, so resolve the constant directly for that case.
    const ruleBasePath =
      owningNode.kind === "single" && owningNode.path !== ROOT_NODE_PATH
        ? resolveRulePath(owningNode)
        : ".cogni/rules";

    const rules: Record<string, Rule> = {};
    for (const gate of gatesConfig.gates) {
      if (gate.type === "ai-rule" && gate.with?.rule_file) {
        const ruleFile = gate.with.rule_file as string;
        if (!rules[ruleFile]) {
          try {
            const ruleYaml = await fetchRepoFile(
              octokit,
              owner,
              repo,
              `${ruleBasePath}/${ruleFile}`,
              pr.base.ref
            );
            rules[ruleFile] = parseRule(ruleYaml);
          } catch (error) {
            logger.warn(
              { ruleFile, error: String(error) },
              "Failed to fetch rule file from repo"
            );
          }
        }
      }
    }

    const allEvaluations: Array<{ metric: string; prompt: string }> = [];
    for (const gate of gatesConfig.gates) {
      if (gate.type === "ai-rule" && gate.with?.rule_file) {
        const rule = rules[gate.with.rule_file as string];
        if (rule?.evaluations) {
          for (const entry of rule.evaluations) {
            const entries = Object.entries(entry);
            const [metric, prompt] = entries[0] as [string, string];
            allEvaluations.push({ metric, prompt });
          }
        }
      }
    }

    const diffSummary = evidence.patches
      .map((p) => `### ${p.filename}\n${p.patch}`)
      .join("\n\n");

    const userMessage =
      allEvaluations.length > 0
        ? buildReviewUserMessage({
            prTitle: evidence.prTitle,
            prBody: evidence.prBody,
            diffSummary,
            evaluations: allEvaluations,
          })
        : "";

    const responseFormat = {
      prompt:
        "Respond with a JSON object containing a `metrics` array and a `summary` string. " +
        "Each metric entry must have: `metric` (name), `value` (0.0-1.0), `observations` (string array).",
      schemaId: "evaluation-output",
    };

    return {
      evidence,
      reviewEnabled,
      gatesConfig,
      rules,
      graphMessages: userMessage
        ? [{ role: "user", content: userMessage }]
        : [],
      responseFormat,
      modelRef,
      repoSpecYaml,
      changedFiles,
      owningNode,
    };
  }

  return { createCheckRun, updateCheckRun, postPrComment, fetchPrContext };
}

export type GithubReviewAdapter = ReturnType<typeof createGithubReviewAdapter>;
