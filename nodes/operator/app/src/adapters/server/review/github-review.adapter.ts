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
 *   - PINNED_REVIEW_SUBJECT (story.5102): `resolvePullRequest` pins head + base SHAs for the
 *     dev-triggered verb; `fetchPrContext` reads repo-spec + rules at the pinned base and compares
 *     the PR head to the pinned head once (`headMoved`).
 *   - CHECK_IS_REQUEST_BOUND: `createCheckRun` writes the request id as the check `external_id`.
 *   - ABSENT_ONLY_ON_404: a repo-spec read is "absent" only on HTTP 404; other errors throw.
 *   - QUEUE_VERDICT_IO_ONLY (task.5438): `readQueueVerdictInputs` / `writeQueueVerdict` only read and
 *     write check runs; the copy decision is the pure `features/review/queue-verdict`. A queue
 *     verdict counts as already written only when THIS App wrote a completed run (redelivery no-ops).
 *   - SERVED_DEFAULT_MODEL: the default review model is `deepseek-v4-flash` (served, the fleet default_free);
 *     a node may override it with repo-spec `review.model`, EXCEPT when `payerKind` is `system_free`
 *     (story.0038): the system tenant pays only for the default model and `review.model` is ignored.
 * Side-effects: IO (GitHub REST API)
 * Links: bug.5000, story.5102, docs/spec/node-ci-cd-contract.md#single-domain-scope,
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
import { createAppAuth } from "@octokit/auth-app";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createInstallationOctokit } from "./github-auth";

// ---------------------------------------------------------------------------
// Constants (ported from the former worker review activity)
// ---------------------------------------------------------------------------

/** The check the review App writes; the review KPIs (task.5450) read exactly this name. */
export const CHECK_RUN_NAME = "Cogni Git PR Review";
/** Served free (default_free) 1M-context model with reliable tool calls (hub `model-pricing-registry`). */
export const DEFAULT_REVIEW_MODELREF = {
  providerKey: "platform",
  modelId: "deepseek-v4-flash",
} as const;
/** The verb path (POST /api/v1/vcs/review) is a user request: every GitHub call is bounded. */
const VERB_REQUEST_TIMEOUT_MS = 10_000;
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
  /** Serving operator build (APP_BUILD_SHA) stamped on the context; null when unversioned. */
  buildSha?: string | null;
}

/** A PR pinned for review by the dev-triggered verb. */
export interface PinnedPullRequest {
  readonly installationId: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly state: string;
}

/** One check run read off a commit, narrowed to what the merge-queue verdict copy needs. */
export interface QueueHeadCheckRun {
  readonly id: number;
  readonly name: string;
  /** Integration id that wrote the run (`app.id`); null when GitHub reports none. */
  readonly appId: number | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string | null;
}

/** What the queue-verdict copy must know before deciding (task.5438). */
export interface QueueVerdictInputs {
  readonly installationId: number;
  /** The PR's current head SHA. */
  readonly headSha: string;
  /** Every `Cogni Git PR Review` run on the head (all Apps; the decision filters by App id). */
  readonly headRuns: readonly QueueHeadCheckRun[];
  /** This App already wrote a completed verdict on the queue commit (redelivery guard). */
  readonly queueHasVerdict: boolean;
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
  /** The PR head differs from the pinned head the request was made for. */
  headMoved: boolean;
  /** Serving operator build that produced this context. */
  operatorBuildSha: string | null;
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

  const operatorBuildSha = deps.buildSha ?? null;

  function octokitFor(installationId: number): Octokit {
    return createInstallationOctokit(installationId, appId, privateKeyBase64);
  }

  /**
   * Resolve the review App's installation on a repo (App JWT). Throws `review_app_not_installed`
   * with the HTTP status when absent (callers map it).
   */
  async function resolveInstallationId(target: {
    owner: string;
    repo: string;
  }): Promise<number> {
    const appAuth = createAppAuth({
      appId,
      privateKey: Buffer.from(privateKeyBase64, "base64").toString("utf-8"),
    });
    const { token } = await appAuth({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(VERB_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `review App not installed on ${target.owner}/${target.repo} (HTTP ${response.status})`
        ),
        { status: response.status, code: "review_app_not_installed" }
      );
    }
    return ((await response.json()) as { id: number }).id;
  }

  /**
   * Pin a PR for the dev-triggered review verb: resolve the installation, then read the PR head +
   * base SHAs once. Throws on a missing installation or PR (callers map the HTTP status).
   */
  async function resolvePullRequest(target: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<PinnedPullRequest> {
    const installationId = await resolveInstallationId(target);
    const pr = await createInstallationOctokit(
      installationId,
      appId,
      privateKeyBase64,
      VERB_REQUEST_TIMEOUT_MS
    ).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: target.owner,
      repo: target.repo,
      pull_number: target.prNumber,
    });
    return {
      installationId,
      headSha: pr.data.head.sha,
      baseSha: pr.data.base.sha,
      state: pr.data.state,
    };
  }

  /**
   * Is the review App installed on `owner/repo`? A 404 is "not installed" (false); any other failure
   * throws (callers report githubReady unknown, never a false "ready").
   */
  async function isReviewAppInstalled(target: {
    owner: string;
    repo: string;
  }): Promise<boolean> {
    try {
      await resolveInstallationId(target);
      return true;
    } catch (error) {
      if ((error as { status?: unknown })?.status === 404) return false;
      throw error;
    }
  }

  /**
   * Read a node's mission (`intent.mission`) from its repo-spec at a pinned commit (story.0038). The
   * mission of a LINKED node comes from its own declared source, the repo-spec, at the PR's pinned base.
   * Returns null when the file is absent, unparseable or has no mission (callers fail closed).
   */
  async function readNodeMission(target: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<string | null> {
    const installationId = await resolveInstallationId(target);
    const octokit = createInstallationOctokit(
      installationId,
      appId,
      privateKeyBase64,
      VERB_REQUEST_TIMEOUT_MS
    );
    let yaml: string;
    try {
      yaml = await fetchRepoFile(
        octokit,
        target.owner,
        target.repo,
        ".cogni/repo-spec.yaml",
        target.ref
      );
    } catch (error) {
      if ((error as { status?: unknown })?.status === 404) return null;
      throw error;
    }
    try {
      const mission = (
        parseYaml(yaml) as { intent?: { mission?: unknown } } | null
      )?.intent?.mission;
      return typeof mission === "string" && mission.trim()
        ? mission.trim()
        : null;
    } catch {
      return null;
    }
  }

  /** Every run of the verdict check on a commit (`filter: all`, so a re-run never hides a verdict). */
  async function listVerdictRuns(
    octokit: Octokit,
    target: { owner: string; repo: string; sha: string }
  ): Promise<QueueHeadCheckRun[]> {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      {
        owner: target.owner,
        repo: target.repo,
        ref: target.sha,
        check_name: CHECK_RUN_NAME,
        filter: "all",
        per_page: 100,
      }
    );
    return response.data.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      appId: run.app?.id ?? null,
      status: run.status,
      conclusion: run.conclusion ?? null,
      htmlUrl: run.html_url ?? null,
    }));
  }

  /**
   * Read what the queue-verdict copy needs (task.5438): the PR's head SHA, the review checks on it,
   * and whether this App already wrote a completed verdict on the queue commit. Bounded reads only.
   */
  async function readQueueVerdictInputs(target: {
    owner: string;
    repo: string;
    prNumber: number;
    queueSha: string;
  }): Promise<QueueVerdictInputs> {
    const installationId = await resolveInstallationId(target);
    const octokit = createInstallationOctokit(
      installationId,
      appId,
      privateKeyBase64,
      VERB_REQUEST_TIMEOUT_MS
    );
    const pr = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: target.owner,
        repo: target.repo,
        pull_number: target.prNumber,
      }
    );
    const headSha = pr.data.head.sha;
    const [headRuns, queueRuns] = await Promise.all([
      listVerdictRuns(octokit, { ...target, sha: headSha }),
      listVerdictRuns(octokit, { ...target, sha: target.queueSha }),
    ]);
    const queueHasVerdict = queueRuns.some(
      (run) => run.appId === Number(appId) && run.status === "completed"
    );
    return { installationId, headSha, headRuns, queueHasVerdict };
  }

  /** Write the completed verdict check on the queue's merge-group commit. Returns the run id. */
  async function writeQueueVerdict(target: {
    installationId: number;
    owner: string;
    repo: string;
    queueSha: string;
    verdict: {
      readonly conclusion: "success" | "failure";
      readonly title: string;
      readonly summary: string;
    };
  }): Promise<number> {
    const octokit = createInstallationOctokit(
      target.installationId,
      appId,
      privateKeyBase64,
      VERB_REQUEST_TIMEOUT_MS
    );
    const now = new Date().toISOString();
    const response = await octokit.request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        owner: target.owner,
        repo: target.repo,
        name: CHECK_RUN_NAME,
        head_sha: target.queueSha,
        status: "completed",
        conclusion: target.verdict.conclusion,
        started_at: now,
        completed_at: now,
        external_id: `queue-verdict:${target.queueSha}`,
        output: {
          title: target.verdict.title,
          summary: target.verdict.summary,
        },
      }
    );
    return response.data.id;
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
        ...(target.externalId ? { external_id: target.externalId } : {}),
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
    // SYSTEM_FREE_MODEL_IS_ALWAYS_THE_DEFAULT (story.0038): when the system tenant pays, the model is
    // DEFAULT_REVIEW_MODELREF and the reviewed repo-spec's `review.model` is ignored entirely. No
    // catalog lookup is a free test here (`isModelFreeFromCache` is true for every ChatGPT id).
    const systemFree = target.payerKind === "system_free";

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
    // PINNED_REVIEW_SUBJECT: read config at the pinned base commit; compare the head once.
    const configRef = target.baseSha ?? pr.base.ref;
    const headMoved =
      target.headSha !== undefined && pr.head.sha !== target.headSha;

    // Fetch repo-spec from target repo (pinned base commit, else base branch)
    let repoSpecYaml: string;
    try {
      repoSpecYaml = await fetchRepoFile(
        octokit,
        owner,
        repo,
        ".cogni/repo-spec.yaml",
        configRef
      );
    } catch (error) {
      // Only a 404 means "no repo-spec". Any other failure (401, 5xx, network) throws so the
      // Temporal activity retries instead of silently reviewing with no gates.
      if ((error as { status?: unknown })?.status !== 404) throw error;
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
        headMoved,
        operatorBuildSha,
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
      if (reviewConfig.model && !systemFree) {
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
      if (
        typeof review.model === "string" &&
        review.model.length > 0 &&
        !systemFree
      ) {
        modelRef = { providerKey: "platform", modelId: review.model };
      }
    }

    // Owning-domain resolution. The structured `review.routed` log is emitted by
    // the worker activity (the orchestrator's observability for the
    // validate-candidate scorecard loop), not here — see services/scheduler-worker review.ts.
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
              configRef
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
        "Respond with a JSON object containing a `metrics` array, a `summary` string and an optional `insufficientEvidence` boolean. " +
        "Each metric entry must have: `metric` (name), `value` (0.0-1.0), `observations` (string array) and `citations` " +
        "(string array of the exact hub entry ids you read with core__knowledge_read that the score rests on; empty when none).",
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
      headMoved,
      operatorBuildSha,
    };
  }

  return {
    createCheckRun,
    updateCheckRun,
    postPrComment,
    fetchPrContext,
    resolvePullRequest,
    isReviewAppInstalled,
    readNodeMission,
    readQueueVerdictInputs,
    writeQueueVerdict,
  };
}

export type GithubReviewAdapter = ReturnType<typeof createGithubReviewAdapter>;
