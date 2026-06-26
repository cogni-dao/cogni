// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/github-review`
 * Purpose: Operator-owned GitHub plane for PR review — create/finalize check runs,
 *   post PR comments, and build the full review context (PR reads + repo-spec
 *   orchestration). The scheduler-worker's review activities HTTP-delegate here
 *   so the worker holds no GitHub credential (bug.5000).
 * Scope: All GitHub I/O (Octokit) + repo-spec parsing for review live here. Thin
 *   app review facade calls these methods; the GitHub App private key never
 *   leaves the operator.
 * Invariants:
 *   - AUTH_VIA_APP: installation token via createInstallationOctokit (JWT exchange).
 *   - TOKEN_SHORT_LIVED: tokens are never persisted.
 *   - Owning-domain resolution mirrors the CI single-node-scope gate; `conflict`
 *     and `miss` short-circuit upstream in the workflow.
 * Side-effects: IO (GitHub REST API)
 * Links: bug.5000, docs/spec/node-ci-cd-contract.md#single-domain-scope,
 *   github-auth.ts
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
  type GateConfig,
  type GatesConfig,
  type OwningNode,
  parseRepoSpec,
  parseRule,
  type RepoSpec,
  type Rule,
  resolveRulePath,
} from "@cogni/repo-spec";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createInstallationOctokit } from "./github-auth";

// ---------------------------------------------------------------------------
// Constants (ported from the former worker review activity)
// ---------------------------------------------------------------------------

const CHECK_RUN_NAME = "Cogni Git PR Review";
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
  gatesConfig: GatesConfig;
  rules: Record<string, Rule>;
  repoSpecYaml?: string;
  changedFiles: string[];
  owningNode: OwningNode;
}

interface EvidenceBundle {
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

    // Fetch root repo-spec from target repo (base branch). In the monorepo it
    // owns routing; for node-at-root repos it is also the node spec.
    let rootRepoSpecYaml: string;
    try {
      rootRepoSpecYaml = await fetchRepoFile(
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
        gatesConfig: { gates: [], failOnError: false },
        rules: {},
        changedFiles,
        owningNode: { kind: "miss" },
      };
    }

    // Parse the root spec for routing. Target repos should parse strictly; when
    // they do not, review degrades to miss rather than spending tokens.
    let parsedSpec: RepoSpec | null = null;
    try {
      parsedSpec = parseRepoSpec(rootRepoSpecYaml);
    } catch {
      parsedSpec = null;
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
    const nodeSpecPath =
      owningNode.kind === "single" && owningNode.path !== ROOT_NODE_PATH
        ? `${owningNode.path}/.cogni/repo-spec.yaml`
        : ".cogni/repo-spec.yaml";

    let nodeRepoSpecYaml = rootRepoSpecYaml;
    if (nodeSpecPath !== ".cogni/repo-spec.yaml") {
      try {
        nodeRepoSpecYaml = await fetchRepoFile(
          octokit,
          owner,
          repo,
          nodeSpecPath,
          pr.base.ref
        );
      } catch (error) {
        logger.warn(
          { nodeSpecPath, error: String(error) },
          "Failed to fetch node-owned repo-spec; review gates disabled"
        );
        nodeRepoSpecYaml = "";
      }
    }

    const gatesConfig = extractNodeGatesConfig(nodeRepoSpecYaml);

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

    return {
      evidence,
      gatesConfig,
      rules,
      repoSpecYaml: nodeRepoSpecYaml,
      changedFiles,
      owningNode,
    };
  }

  return { createCheckRun, updateCheckRun, postPrComment, fetchPrContext };
}

export type GithubReviewAdapter = ReturnType<typeof createGithubReviewAdapter>;

function extractNodeGatesConfig(repoSpecYaml: string): GatesConfig {
  if (!repoSpecYaml) {
    return { gates: [], failOnError: false };
  }

  try {
    return extractGatesConfig(parseRepoSpec(repoSpecYaml));
  } catch {
    const raw = parseYaml(repoSpecYaml) as Record<string, unknown>;
    const gates = Array.isArray(raw.gates) ? raw.gates : [];
    return {
      gates: gates as GateConfig[],
      failOnError: raw.fail_on_error === true,
    };
  }
}
