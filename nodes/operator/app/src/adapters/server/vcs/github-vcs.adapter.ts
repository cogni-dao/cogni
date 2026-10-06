// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-vcs`
 * Purpose: VcsCapability adapter using Octokit + GitHub App authentication.
 * Scope: Implements VcsCapability for GitHub API operations (list PRs, CI status, merge, create branch, dispatch candidate-flight).
 * Invariants:
 *   - MERGE_IS_QUEUE_TOLERANT: `mergePr` detects the base branch's merge-queue state (GraphQL
 *     `mergeQueue`) and either direct-merges (no queue → `merged` + `sha`) or enqueues via
 *     `enablePullRequestAutoMerge` (queue required → `enqueued`, async, no `sha`).
 *   - AUTH_VIA_APP: Uses @octokit/auth-app for GitHub App JWT + installation token management
 *   - INSTALLATION_CACHED: Installation ID resolved once per owner/repo and cached
 *   - TOKEN_AUTO_REFRESH: Octokit auth-app handles token caching and refresh automatically
 *   - ADAPTER_SWAPPABLE: Implements VcsCapability — can be swapped for gh CLI adapter later
 *   - FLIGHT_WORKFLOW_REF: `candidate-flight.yml` is dispatched against `workflowRef ?? "main"`.
 *     Defaults to main; pass workflowRef to test workflow changes on a feature branch.
 * Side-effects: IO (GitHub REST API)
 * Links: task.0242, task.0297, services/scheduler-worker/src/adapters/ingestion/github-auth.ts
 * @internal
 */

import type {
  ApproveWorkflowRunsResult,
  CheckInfo,
  CiStatusResult,
  CreateBranchResult,
  DispatchCandidateFlightResult,
  MergeResult,
  OperatorChangeFastForwardResult,
  OperatorChangeVerificationResult,
  PrSummary,
  VcsCapability,
} from "@cogni/ai-tools";
import type {
  OperatorChangeIntent,
  OperatorChangeRecoveryRequest,
  OperatorChangeRecoveryResult,
} from "@cogni/node-contracts";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { parse as parseYaml } from "yaml";
import {
  classifyOperatorChangeForMerge,
  classifyOperatorChangeForRecovery,
  type OperatorChangeFacts,
  parseOperatorChangeRegistry,
} from "@/shared/vcs/operator-change-policy";
import {
  type OperatorChangeReplayReader,
  parseOperatorChangeIntent,
  replayOperatorChange,
} from "@/shared/vcs/operator-change-replay";
import { GitHubRepoWriter } from "./github-repo-write";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubVcsAdapterConfig {
  readonly appId: string;
  readonly privateKey: string;
  /** Trusted repository whose main branch owns generated-change policy. */
  readonly operatorChangePolicyOwner?: string;
  readonly operatorChangePolicyRepo?: string;
  readonly fleetControlEnv?: string | undefined;
  readonly forkDomainRoot?: string | undefined;
}

interface RequiredStatusCheck {
  readonly context: string;
  readonly appId?: number;
}

interface StatusCheckEvidence {
  readonly status: string;
  readonly conclusion: string | null;
  readonly source: "check-run" | "legacy-status";
  readonly appId?: number;
  readonly appSlug?: string;
}

interface RequiredStatusChecksResult {
  readonly checks: readonly RequiredStatusCheck[];
  readonly complete: boolean;
}

function hasNextPage(response: {
  readonly headers?: Readonly<Record<string, string | number | undefined>>;
}): boolean {
  const link = response.headers?.link;
  return typeof link === "string" && /rel="next"/.test(link);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GitHubVcsAdapter implements VcsCapability {
  private readonly config: GitHubVcsAdapterConfig;
  private readonly appAuth: ReturnType<typeof createAppAuth>;
  private readonly installationCache = new Map<string, number>();

  constructor(config: GitHubVcsAdapterConfig) {
    this.config = config;
    this.appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  async listPrs(params: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
  }): Promise<readonly PrSummary[]> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: params.owner,
      repo: params.repo,
      state: params.state ?? "open",
      per_page: 50,
    });

    return data.map(
      (pr): PrSummary => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "unknown",
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        labels: pr.labels.map(
          (l) => (typeof l === "string" ? l : l.name) ?? ""
        ),
        draft: pr.draft ?? false,
        mergeable: null, // List endpoint doesn't include mergeable
        updatedAt: pr.updated_at,
      })
    );
  }

  async getCiStatus(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<CiStatusResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // Fetch PR metadata
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
      }
    );

    // Fetch check runs, combined status, and reviews in parallel
    const [checksResponse, statusResponse, reviewsResponse, commitResponse] =
      await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
          owner: params.owner,
          repo: params.repo,
          ref: pr.head.sha,
          per_page: 100,
        }),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
          owner: params.owner,
          repo: params.repo,
          ref: pr.head.sha,
          per_page: 100,
        }),
        octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner: params.owner,
            repo: params.repo,
            pull_number: params.prNumber,
            per_page: 100,
          }
        ),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner: params.owner,
          repo: params.repo,
          ref: pr.head.sha,
        }),
      ]);

    const rawCheckRuns = checksResponse.data.check_runs as Array<{
      name: string;
      status: string;
      conclusion: string | null;
      app: { id: number; slug: string } | null;
    }>;
    const evidenceComplete =
      !hasNextPage(checksResponse) &&
      !hasNextPage(statusResponse) &&
      (checksResponse.data.total_count ?? rawCheckRuns.length) <=
        rawCheckRuns.length &&
      (statusResponse.data.total_count ??
        statusResponse.data.statuses.length) <=
        statusResponse.data.statuses.length;

    const checks: CheckInfo[] = [
      // Modern check runs (all — for observability)
      ...rawCheckRuns.map((cr) => ({
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
      })),
      // Legacy commit statuses
      ...(
        statusResponse.data.statuses as Array<{
          context: string;
          state: string;
        }>
      ).map((s) => ({
        name: s.context,
        status: "completed",
        conclusion:
          s.state === "success"
            ? "success"
            : s.state === "pending"
              ? null
              : "failure",
      })),
    ];

    // Keep every producer for a context. A same-name check from another App must
    // never overwrite or impersonate the producer GitHub bound in branch policy.
    const byContext = new Map<string, StatusCheckEvidence[]>();
    for (const cr of rawCheckRuns) {
      const evidence = byContext.get(cr.name) ?? [];
      evidence.push({
        status: cr.status,
        conclusion: cr.conclusion,
        source: "check-run",
        ...(cr.app ? { appId: cr.app.id, appSlug: cr.app.slug } : {}),
      });
      byContext.set(cr.name, evidence);
    }
    for (const s of statusResponse.data.statuses as Array<{
      context: string;
      state: string;
    }>) {
      const evidence = byContext.get(s.context) ?? [];
      evidence.push({
        status: "completed",
        conclusion:
          s.state === "success"
            ? "success"
            : s.state === "pending"
              ? null
              : "failure",
        source: "legacy-status",
      });
      byContext.set(s.context, evidence);
    }

    // REQUIRED_CHECKS_ARE_GITHUB_DEFINED: "green" is GitHub's OWN required-status-
    // check set for the PR's base branch (from classic protection + active
    // rulesets), never an operator-invented list. A required context is satisfied
    // iff it completed
    // success|skipped — GitHub's own rule (a required check that legitimately
    // skips, e.g. a fork-guarded build, is passing). An unprotected branch (no
    // required checks) is NOT green: merge-on-green is meaningless without a
    // required set, so it fails closed.
    const required = await this.getRequiredContexts(
      octokit,
      params.owner,
      params.repo,
      pr.base.ref
    );
    const evidenceFor = (required: RequiredStatusCheck) =>
      (byContext.get(required.context) ?? []).filter((evidence) =>
        required.appId === undefined
          ? evidence.source === "legacy-status" ||
            evidence.appSlug === "github-actions"
          : evidence.source === "check-run" && evidence.appId === required.appId
      );
    const pending =
      !evidenceComplete ||
      !required.complete ||
      required.checks.some((requiredCheck) => {
        const evidence = evidenceFor(requiredCheck);
        return (
          evidence.length === 0 ||
          evidence.some(
            (candidate) =>
              candidate.status !== "completed" || candidate.conclusion === null
          )
        );
      });
    const allGreen =
      evidenceComplete &&
      required.complete &&
      required.checks.length > 0 &&
      required.checks.every((requiredCheck) => {
        const evidence = evidenceFor(requiredCheck);
        return (
          evidence.length > 0 &&
          evidence.every(
            (candidate) =>
              candidate.status === "completed" &&
              (candidate.conclusion === "success" ||
                candidate.conclusion === "skipped")
          )
        );
      });

    // Compute review decision from individual reviews.
    // Take the latest review per reviewer; if any APPROVED and none CHANGES_REQUESTED → approved.
    const reviews = reviewsResponse.data as Array<{
      user: { login: string } | null;
      state: string;
    }>;
    let reviewsOverflow = reviews.length > 100;
    if (reviews.length === 100) {
      const { data: nextReviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
          per_page: 100,
          page: 2,
        }
      );
      reviewsOverflow = nextReviews.length > 0;
    }
    const latestByReviewer = new Map<string, string>();
    for (const review of reviews) {
      if (review.user && review.state !== "COMMENTED") {
        latestByReviewer.set(review.user.login, review.state);
      }
    }
    const reviewStates = [...latestByReviewer.values()];
    let reviewDecision: string | null = null;
    if (reviewsOverflow || reviewStates.includes("CHANGES_REQUESTED")) {
      reviewDecision = "CHANGES_REQUESTED";
    } else if (reviewStates.includes("APPROVED")) {
      reviewDecision = "APPROVED";
    }

    return {
      prNumber: pr.number,
      prTitle: pr.title,
      author: pr.user?.login ?? "unknown",
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      ...(commitResponse.data.parents?.length === 1 &&
      commitResponse.data.parents[0]?.sha
        ? { headParentSha: commitResponse.data.parents[0].sha }
        : {}),
      headCommitMessage: commitResponse.data.commit.message,
      mergeable: pr.mergeable,
      reviewDecision,
      labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name) ?? ""),
      draft: pr.draft ?? false,
      allGreen,
      pending,
      checks,
    };
  }

  async verifyOperatorChange(params: {
    owner: string;
    repo: string;
    prNumber: number;
    expectedHeadSha: string;
  }): Promise<OperatorChangeVerificationResult> {
    const strict = await this.verifyOperatorChangeInternal(params, false);
    if (strict.eligible || strict.reason !== "invalid-pr-identity") {
      return strict;
    }
    const stale = await this.verifyOperatorChangeInternal(params, true);
    if (!stale.eligible || stale.baseSha === strict.baseSha) return strict;
    return { ...stale, eligible: false, reason: "base-advanced" };
  }

  private async verifyOperatorChangeInternal(params: {
    owner: string;
    repo: string;
    prNumber: number;
    expectedHeadSha: string;
  }, allowStaleBase: boolean): Promise<OperatorChangeVerificationResult> {
    const targetOctokit = await this.getOctokit(params.owner, params.repo);
    const { data: pr } = await targetOctokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
      }
    );
    const baseSha = pr.base.sha;
    const headSha = pr.head.sha;
    const fail = (reason: string): OperatorChangeVerificationResult => ({
      eligible: false,
      reason,
      headSha,
      baseSha,
    });
    if (
      !this.config.operatorChangePolicyOwner ||
      !this.config.operatorChangePolicyRepo
    ) {
      return fail("trusted-policy-repository-unconfigured");
    }

    const policyOctokit = await this.getOctokit(
      this.config.operatorChangePolicyOwner,
      this.config.operatorChangePolicyRepo
    );
    const registryText = await this.readFileText(
      policyOctokit,
      this.config.operatorChangePolicyOwner,
      this.config.operatorChangePolicyRepo,
      "scripts/ci/operator-change-v1.allowlist.json",
      "main"
    );
    if (registryText === null) return fail("trusted-registry-unavailable");
    let registryValue: unknown;
    try {
      registryValue = JSON.parse(registryText);
    } catch {
      return fail("invalid-trusted-registry");
    }
    const registry = parseOperatorChangeRegistry(registryValue);
    if (registry === null) return fail("invalid-trusted-registry");

    const [commitResponse, filesResponse] = await Promise.all([
      targetOctokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner: params.owner,
        repo: params.repo,
        ref: headSha,
      }),
      targetOctokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
          per_page: 100,
          page: 1,
        }
      ),
    ]);
    if (filesResponse.headers.link?.includes('rel="next"')) {
      return fail("changed-file-list-truncated");
    }
    const commit = commitResponse.data;
    const replayBaseSha = allowStaleBase
      ? (commit.parents[0]?.sha ?? baseSha)
      : baseSha;
    const baseRepoSpec = await this.readFileText(
      targetOctokit,
      params.owner,
      params.repo,
      ".cogni/repo-spec.yaml",
      replayBaseSha
    );
    let repositoryNode: string | null = null;
    if (baseRepoSpec !== null) {
      try {
        const parsedSpec = parseYaml(baseRepoSpec) as {
          intent?: { name?: unknown };
        } | null;
        if (typeof parsedSpec?.intent?.name === "string") {
          repositoryNode = parsedSpec.intent.name;
        }
      } catch {
        repositoryNode = null;
      }
    }
    const facts: OperatorChangeFacts = {
      repository: `${params.owner}/${params.repo}`,
      repositoryNode,
      expectedHeadSha: params.expectedHeadSha,
      pr: {
        state: pr.state,
        draft: pr.draft ?? true,
        baseRef: pr.base.ref,
        baseSha,
        headRef: pr.head.ref,
        headSha,
        headRepoFullName: pr.head.repo?.full_name ?? null,
        commitCount: pr.commits,
        userLogin: pr.user?.login ?? null,
        userId: pr.user?.id ?? null,
        userType: pr.user?.type ?? null,
      },
      commit: {
        sha: commit.sha,
        message: commit.commit.message,
        verified: commit.commit.verification?.verified === true,
        verificationReason: commit.commit.verification?.reason ?? null,
        authorLogin: commit.author?.login ?? null,
        authorId: commit.author?.id ?? null,
        parents: commit.parents.map((parent) => parent.sha),
      },
      files: filesResponse.data.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename ?? null,
        status: file.status,
      })),
      registry,
      operationReplayVerified: false,
    };

    const classify = allowStaleBase
      ? classifyOperatorChangeForRecovery
      : classifyOperatorChangeForMerge;
    const structural = classify(facts);
    if (
      structural.reason !== "operation-replay-failed" ||
      !structural.operation ||
      !structural.node
    ) {
      return structural;
    }
    const operationReplayVerified = await this.verifyOperatorChangeReplay({
      targetOctokit,
      policyOctokit,
      owner: params.owner,
      repo: params.repo,
      baseSha: replayBaseSha,
      headSha,
      operation: structural.operation,
      node: structural.node,
      files: facts.files.map((file) => file.filename),
      message: commit.commit.message,
    });
    const classified = classify({
      ...facts,
      operationReplayVerified,
    });
    if (!classified.eligible || !classified.operation || !classified.node) {
      return classified;
    }
    try {
      const intent = parseOperatorChangeIntent({
        operation: classified.operation,
        node: classified.node,
        baseSha: replayBaseSha,
        headSha,
        message: commit.commit.message,
      });
      return { ...classified, baseSha: replayBaseSha, intent };
    } catch {
      return { ...classified, eligible: false, reason: "intent-parse-failed" };
    }
  }

  private async verifyOperatorChangeReplay(input: {
    targetOctokit: Octokit;
    policyOctokit: Octokit;
    owner: string;
    repo: string;
    baseSha: string;
    headSha: string;
    operation: string;
    node: string;
    files: readonly string[];
    message: string;
  }): Promise<boolean> {
    const reader: OperatorChangeReplayReader = {
      readFile: async (ref, path) =>
        this.readFileText(
          input.targetOctokit,
          input.owner,
          input.repo,
          path,
          ref
        ),
      listPaths: async (ref, prefix) => {
        const { data } = await input.targetOctokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner: input.owner,
            repo: input.repo,
            path: prefix,
            ref,
          }
        );
        if (!Array.isArray(data)) return [];
        return data
          .filter((entry) => entry.type === "file")
          .map((entry) => `${prefix}/${entry.name}`);
      },
    };
    if (input.operation !== "deployment.declare") {
      return (
        await replayOperatorChange({
          operation: input.operation,
          node: input.node,
          baseSha: input.baseSha,
          headSha: input.headSha,
          message: input.message,
          paths: input.files,
          repository: `${input.owner}/${input.repo}`,
          fleetControlEnv: this.config.fleetControlEnv,
          forkDomainRoot: this.config.forkDomainRoot,
          reader,
        })
      ).verified;
    }
    if (
      input.files.length !== 1 ||
      input.files[0] !== ".cogni/repo-spec.yaml" ||
      !this.config.operatorChangePolicyOwner ||
      !this.config.operatorChangePolicyRepo
    ) {
      return false;
    }
    const catalog = await this.readFileText(
      input.policyOctokit,
      this.config.operatorChangePolicyOwner,
      this.config.operatorChangePolicyRepo,
      `infra/catalog/${input.node}.yaml`,
      "main"
    );
    if (catalog === null) return false;
    return (
      await replayOperatorChange({
        operation: input.operation,
        node: input.node,
        baseSha: input.baseSha,
        headSha: input.headSha,
        message: input.message,
        paths: input.files,
        repository: `${input.owner}/${input.repo}`,
        deploymentCatalog: catalog,
        fleetControlEnv: this.config.fleetControlEnv,
        forkDomainRoot: this.config.forkDomainRoot,
        reader,
      })
    ).verified;
  }

  private async readFileText(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner, repo, path, ref }
      );
      if (
        Array.isArray(data) ||
        data.type !== "file" ||
        typeof data.content !== "string"
      ) {
        return null;
      }
      return Buffer.from(data.content.replaceAll("\n", ""), "base64").toString(
        "utf8"
      );
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      throw error;
    }
  }

  /**
   * The branch's REQUIRED status-check contexts across both GitHub enforcement
   * systems: classic branch protection and active rulesets. GitHub's effective
   * policy is their union; spawned nodes use the rulesets path. An empty check set
   * or a paginated/truncated rules response is incomplete and the merge gate fails
   * closed. The active-rules endpoint includes repository + organization rules and
   * needs only metadata:read.
   */
  private async getRequiredContexts(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<RequiredStatusChecksResult> {
    const checks = new Map<string, RequiredStatusCheck>();
    const add = (context: string, appId?: number) => {
      const key = `${context}\u0000${appId ?? "unbound"}`;
      checks.set(key, {
        context,
        ...(appId === undefined ? {} : { appId }),
      });
    };
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
        { owner, repo, branch }
      );
      const classicChecks = (data.checks ?? []) as ReadonlyArray<{
        context?: string;
        app_id?: number | null;
      }>;
      const producerBoundContexts = new Set<string>();
      for (const check of classicChecks) {
        if (!check.context) continue;
        if (typeof check.app_id === "number" && check.app_id !== -1) {
          producerBoundContexts.add(check.context);
          add(check.context, check.app_id);
        } else {
          add(check.context);
        }
      }
      for (const context of data.contexts ?? []) {
        if (!producerBoundContexts.has(context)) add(context);
      }
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }

    const activeRulesResponse = await octokit.request(
      "GET /repos/{owner}/{repo}/rules/branches/{branch}",
      { owner, repo, branch, per_page: 100 }
    );
    const activeRules = activeRulesResponse.data;
    for (const rule of activeRules as ReadonlyArray<{
      type?: string;
      parameters?: {
        required_status_checks?: ReadonlyArray<{
          context?: string;
          integration_id?: number | null;
        }>;
      };
    }>) {
      if (rule.type !== "required_status_checks") continue;
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (!check.context) continue;
        add(
          check.context,
          typeof check.integration_id === "number"
            ? check.integration_id
            : undefined
        );
      }
    }
    return {
      checks: [...checks.values()],
      complete: !hasNextPage(activeRulesResponse),
    };
  }

  /**
   * Atomically land one verified generated change without entering the merge queue.
   * The head must still be the PR's exact one-parent child of the observed base. GitHub's
   * non-force ref update supplies the final compare-and-swap: if another PR advances the
   * base after these reads, this update is no longer a fast-forward and fails closed.
   */
  async fastForwardOperatorChange(params: {
    owner: string;
    repo: string;
    prNumber: number;
    expectedBaseSha: string;
    expectedHeadSha: string;
  }): Promise<OperatorChangeFastForwardResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);
    let patchIssued = false;
    try {
      const [{ data: pr }, { data: commit }, { data: mainRef }] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
        }),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner: params.owner,
          repo: params.repo,
          ref: params.expectedHeadSha,
        }),
        octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: params.owner,
          repo: params.repo,
          ref: "heads/main",
        }),
      ]);
      if (
        pr.state !== "open" ||
        pr.draft !== false ||
        pr.base.ref !== "main" ||
        pr.head.sha !== params.expectedHeadSha ||
        pr.head.repo?.full_name?.toLowerCase() !==
          `${params.owner}/${params.repo}`.toLowerCase() ||
        commit.sha !== params.expectedHeadSha ||
        commit.parents.length !== 1 ||
        commit.parents[0]?.sha !== params.expectedBaseSha
      ) {
        return {
          outcome: "terminal",
          status: 409,
          message: "Generated change base/head precondition failed",
        };
      }
      if (mainRef.object.sha !== params.expectedBaseSha) {
        return {
          outcome: "base_advanced",
          currentBaseSha: mainRef.object.sha,
          message: "Generated change base advanced before compare-and-swap",
        };
      }
      if (pr.base.sha !== params.expectedBaseSha) {
        return {
          outcome: "terminal",
          status: 409,
          message: "Generated change PR base does not match main",
        };
      }

      patchIssued = true;
      const { data: updated } = await octokit.request(
        "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
        {
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${pr.base.ref}`,
          sha: params.expectedHeadSha,
          force: false,
        }
      );
      return {
        outcome: "landed",
        sha: updated.object.sha,
        message: "Verified generated change fast-forwarded atomically",
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (patchIssued) {
        try {
          const { data: current } = await octokit.request(
            "GET /repos/{owner}/{repo}/git/ref/{ref}",
            { owner: params.owner, repo: params.repo, ref: "heads/main" }
          );
          if (current.object.sha === params.expectedHeadSha) {
            return {
              outcome: "landed",
              sha: params.expectedHeadSha,
              message: "Generated change landed despite an ambiguous PATCH response",
            };
          }
          if (current.object.sha !== params.expectedBaseSha) {
            return {
              outcome: "base_advanced",
              currentBaseSha: current.object.sha,
              message: "Generated change lost the compare-and-swap",
            };
          }
        } catch {
          return {
            outcome: "retryable_or_ambiguous",
            ...(status === undefined ? {} : { status }),
            message: "Generated change PATCH outcome is ambiguous",
          };
        }
      }
      if (
        status === 408 ||
        status === 429 ||
        status === undefined ||
        (typeof status === "number" && status >= 500)
      ) {
        return {
          outcome: "retryable_or_ambiguous",
          ...(status === undefined ? {} : { status }),
          message: error instanceof Error ? error.message : "GitHub request failed",
        };
      }
      return {
        outcome: "terminal",
        ...(status === undefined ? {} : { status }),
        message: error instanceof Error ? error.message : "GitHub request failed",
      };
    }
  }

  async recoverOperatorChange(
    request: OperatorChangeRecoveryRequest
  ): Promise<OperatorChangeRecoveryResult> {
    const octokit = await this.getOctokit(request.owner, request.repo);
    const [{ data: mainRef }, { data: pr }] = await Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: request.owner,
        repo: request.repo,
        ref: "heads/main",
      }),
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: request.owner,
        repo: request.repo,
        pull_number: request.prNumber,
      }),
    ]);
    const mainSha = mainRef.object.sha;
    if (mainSha === request.losingHeadSha) {
      return { status: "satisfied", reason: "main_equals_losing_head", mainSha };
    }
    if (
      pr.head.sha !== request.losingHeadSha ||
      pr.head.repo?.full_name?.toLowerCase() !==
        `${request.owner}/${request.repo}`.toLowerCase()
    ) {
      return { status: "terminal", reason: "losing-pr-head-changed" };
    }
    if (pr.state === "closed" && pr.merged_at !== null) {
      return { status: "satisfied", reason: "exact_pr_merged", mainSha };
    }
    if (
      !["open", "closed"].includes(pr.state) ||
      pr.draft === true ||
      pr.base.ref !== "main"
    ) {
      return { status: "terminal", reason: "losing-pr-is-not-recoverable" };
    }

    const proof = await this.verifyOperatorChangeInternal(
      {
        owner: request.owner,
        repo: request.repo,
        prNumber: request.prNumber,
        expectedHeadSha: request.losingHeadSha,
      },
      true
    );
    if (
      !proof.eligible ||
      proof.baseSha !== request.signedBaseSha ||
      proof.intent === undefined ||
      JSON.stringify(proof.intent) !== JSON.stringify(request.intent)
    ) {
      return { status: "terminal", reason: `losing-head-verification-failed:${proof.reason}` };
    }
    const ci = await this.getCiStatus({
      owner: request.owner,
      repo: request.repo,
      prNumber: request.prNumber,
    });
    if (
      ci.headSha !== request.losingHeadSha ||
      ci.reviewDecision === "CHANGES_REQUESTED" ||
      ci.pending ||
      !ci.allGreen
    ) {
      return { status: "terminal", reason: "losing-head-checks-not-green" };
    }
    if (mainSha === request.signedBaseSha) {
      const retried = await this.fastForwardOperatorChange({
        owner: request.owner,
        repo: request.repo,
        prNumber: request.prNumber,
        expectedBaseSha: request.signedBaseSha,
        expectedHeadSha: request.losingHeadSha,
      });
      if (retried.outcome === "landed") {
        return { status: "landed", mainSha: retried.sha };
      }
      if (retried.outcome === "terminal") {
        return { status: "terminal", reason: retried.message };
      }
      if (retried.outcome === "retryable_or_ambiguous") {
        throw new Error(`retryable_or_ambiguous:${retried.message}`);
      }
    }

    const writer = new GitHubRepoWriter({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      ...(this.config.operatorChangePolicyOwner
        ? { operatorChangePolicyOwner: this.config.operatorChangePolicyOwner }
        : {}),
      ...(this.config.operatorChangePolicyRepo
        ? { operatorChangePolicyRepo: this.config.operatorChangePolicyRepo }
        : {}),
      ...(this.config.fleetControlEnv
        ? { fleetControlEnv: this.config.fleetControlEnv }
        : {}),
      ...(this.config.forkDomainRoot
        ? { forkDomainRoot: this.config.forkDomainRoot }
        : {}),
    });
    const regenerated = await writer.createOperatorChangeRecoveryPr({
      owner: request.owner,
      repo: request.repo,
      intent: request.intent,
      ...(pr.state === "closed" ? { planOnly: true } : {}),
    });
    if (regenerated.status === "conflict") {
      return { status: "terminal", reason: regenerated.reason };
    }
    if (regenerated.status === "satisfied") {
      const { data: freshPr } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner: request.owner, repo: request.repo, pull_number: request.prNumber }
      );
      if (freshPr.state === "open" && freshPr.head.sha === request.losingHeadSha) {
        await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: request.owner,
          repo: request.repo,
          pull_number: request.prNumber,
          state: "closed",
        });
      }
      return {
        status: "satisfied",
        reason: "intent_already_satisfied",
        mainSha: regenerated.mainSha,
      };
    }
    const regeneratedProof = await this.verifyOperatorChange({
      owner: request.owner,
      repo: request.repo,
      prNumber: regenerated.prNumber,
      expectedHeadSha: regenerated.headSha,
    });
    if (
      !regeneratedProof.eligible ||
      regeneratedProof.baseSha !== regenerated.baseSha ||
      regeneratedProof.intent === undefined ||
      JSON.stringify(regeneratedProof.intent) !== JSON.stringify(regenerated.intent)
    ) {
      return { status: "terminal", reason: `regenerated-head-verification-failed:${regeneratedProof.reason}` };
    }
    return {
      status: "regenerated",
      baseSha: regenerated.baseSha,
      headSha: regenerated.headSha,
      prNumber: regenerated.prNumber,
      prUrl: regenerated.prUrl,
      recoveryDepth: regenerated.intent.recoveryDepth,
    };
  }

  /**
   * Merge a PR — queue-tolerant by default. When the base branch requires a merge queue,
   * GitHub `405`s a direct `PUT .../merge`, so we instead enable auto-merge
   * (`enablePullRequestAutoMerge`), which GitHub routes through the queue: the
   * merge happens asynchronously on the queue's rebased candidate (`enqueued`,
   * no `sha` yet). When no queue is required (today's state everywhere), we
   * direct-merge exactly as before (`merged` + `sha`, synchronous). The branch's
   * queue state is detected deterministically up front (GraphQL `mergeQueue`) so
   * we never have to disambiguate a `405`.
   *
   * MERGED_XOR_ENQUEUED: this capability independently re-reads and gates the PR
   * before choosing the execution path by queue requirement. Every direct merge
   * also sends `expectedHeadSha`; queue enablement sends `expectedHeadOid`. The
   * signed generated-change fast lane is deliberately separate in
   * `fastForwardOperatorChange`.
   */
  async mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
    expectedHeadSha: string;
  }): Promise<MergeResult> {
    // CAPABILITY_BOUNDARY_MERGE_GATE: the App may be the configured v2 ruleset
    // bypass actor, so GitHub protection cannot be the only guard. Re-read every
    // merge fact here, at the write capability boundary, before queue discovery
    // or either merge write. Callers may preflight for UX, but cannot authorize.
    let ci: CiStatusResult;
    try {
      ci = await this.getCiStatus({
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
      });
    } catch (error) {
      return this.toMergeFailure(error);
    }
    if (ci.headSha !== params.expectedHeadSha) {
      return {
        merged: false,
        enqueued: false,
        status: 409,
        message: "PR head changed after the caller observed CI; retry",
      };
    }
    if (
      ci.baseBranch !== "main" ||
      ci.draft ||
      !ci.allGreen ||
      ci.pending ||
      ci.mergeable !== true ||
      ci.reviewDecision === "CHANGES_REQUESTED"
    ) {
      return {
        merged: false,
        enqueued: false,
        status: 422,
        message:
          "PR is not eligible to merge: require main base, non-draft, complete green checks, mergeable state, and no review hold",
      };
    }

    const octokit = await this.getOctokit(params.owner, params.repo);

    // Resolve the PR's base branch + GraphQL node id once (node id is required by
    // the auto-merge mutation; base ref drives the queue check).
    let baseRef: string;
    let prNodeId: string;
    try {
      const { data: pr } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner: params.owner, repo: params.repo, pull_number: params.prNumber }
      );
      baseRef = pr.base.ref;
      prNodeId = pr.node_id;
    } catch (error) {
      return this.toMergeFailure(error);
    }

    let queueEnabled: boolean;
    try {
      queueEnabled = await this.isMergeQueueEnabled(
        octokit,
        params.owner,
        params.repo,
        baseRef
      );
    } catch (error) {
      return this.toMergeFailure(error);
    }

    if (queueEnabled) {
      try {
        await this.enableAutoMerge(
          octokit,
          prNodeId,
          params.method,
          params.expectedHeadSha
        );
        return {
          merged: false,
          enqueued: true,
          message: `Pull request added to the merge queue on '${baseRef}' (async — merge completes on the queue's rebased candidate)`,
        };
      } catch (error) {
        return this.toMergeFailure(error);
      }
    }

    try {
      const { data } = await octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
          merge_method: params.method,
          sha: params.expectedHeadSha,
        }
      );

      return {
        merged: data.merged,
        enqueued: false,
        sha: data.sha,
        message: data.message,
      };
    } catch (error) {
      return this.toMergeFailure(error);
    }
  }

  /**
   * Normalize a thrown GitHub error into a failed `MergeResult`, surfacing the
   * HTTP status so callers classify structurally (405 = refused/not-mergeable/
   * already-merged, 409 = head modified) rather than substring-matching.
   */
  private toMergeFailure(error: unknown): MergeResult {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;
    const message = error instanceof Error ? error.message : "Merge failed";
    // exactOptionalPropertyTypes: omit `status` rather than set it `undefined`.
    return status === undefined
      ? { merged: false, enqueued: false, message }
      : { merged: false, enqueued: false, status, message };
  }

  /**
   * True when `branch` has an active merge queue (a `merge_queue` ruleset or the
   * legacy "Require merge queue" toggle). GraphQL `repository.mergeQueue(branch)`
   * returns a non-null node when one exists. Discovery failure propagates to a
   * structured merge failure; it can never degrade into a direct App write.
   */
  private async isMergeQueueEnabled(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<boolean> {
    const result = await octokit.graphql<{
      repository: { mergeQueue: { id: string } | null } | null;
    }>(
      `query ($owner: String!, $repo: String!, $branch: String!) {
          repository(owner: $owner, name: $repo) {
            mergeQueue(branch: $branch) { id }
          }
        }`,
      { owner, repo, branch }
    );
    return Boolean(result.repository?.mergeQueue?.id);
  }

  /** Enable auto-merge on a PR (routes through the merge queue when required). */
  private async enableAutoMerge(
    octokit: Octokit,
    pullRequestId: string,
    method: "squash" | "merge" | "rebase",
    expectedHeadOid: string
  ): Promise<void> {
    const mergeMethod = method.toUpperCase(); // GraphQL PullRequestMergeMethod
    await octokit.graphql(
      `mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) {
          pullRequest { id state }
        }
      }`,
      { pullRequestId, mergeMethod, expectedHeadOid }
    );
  }

  async dispatchCandidateFlight(params: {
    owner: string;
    repo: string;
    nodeSlug: string;
    sourceSha: string;
    workflowRef?: string;
  }): Promise<DispatchCandidateFlightResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    const inputs: Record<string, string> = {
      node_slug: params.nodeSlug,
      source_sha: params.sourceSha,
    };

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: params.owner,
        repo: params.repo,
        workflow_id: "candidate-flight.yml",
        ref: params.workflowRef ?? "main",
        inputs,
      }
    );

    const workflowUrl = `https://github.com/${params.owner}/${params.repo}/actions/workflows/candidate-flight.yml`;

    return {
      dispatched: true,
      nodeSlug: params.nodeSlug,
      sourceSha: params.sourceSha,
      workflowUrl,
      message: `Candidate flight dispatched for ${params.nodeSlug}@${params.sourceSha.slice(0, 8)}.`,
    };
  }

  async approveWorkflowRuns(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<ApproveWorkflowRunsResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // Resolve the PR head SHA — workflow runs are keyed by head_sha.
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
      }
    );
    const headSha = pr.head.sha;

    // List the workflow runs GitHub is holding behind the fork-PR approval gate.
    const { data: runsData } = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: params.owner,
        repo: params.repo,
        head_sha: headSha,
        status: "action_required",
        event: "pull_request",
        per_page: 100,
      }
    );

    const pending = runsData.workflow_runs as Array<{ id: number }>;

    // Approve each held run. `POST .../actions/runs/{run_id}/approve` requires
    // the installation to hold `actions: write` (cogni-node-template does).
    const runIds: number[] = [];
    for (const run of pending) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
        {
          owner: params.owner,
          repo: params.repo,
          run_id: run.id,
        }
      );
      runIds.push(run.id);
    }

    const shortSha = headSha.slice(0, 8);
    return {
      approved: runIds.length,
      prNumber: params.prNumber,
      headSha,
      headRepo: pr.head.repo?.full_name ?? null,
      runIds,
      message:
        runIds.length > 0
          ? `Approved ${runIds.length} workflow run(s) for PR #${params.prNumber} @ ${shortSha}.`
          : `No workflow runs awaiting approval for PR #${params.prNumber} @ ${shortSha}.`,
    };
  }

  async createBranch(params: {
    owner: string;
    repo: string;
    branch: string;
    fromRef: string;
  }): Promise<CreateBranchResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    let sha: string;
    if (/^[0-9a-f]{40}$/i.test(params.fromRef)) {
      sha = params.fromRef;
    } else {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/ref/{ref}",
        {
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.fromRef}`,
        }
      );
      sha = data.object.sha;
    }

    const { data: refData } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/refs",
      {
        owner: params.owner,
        repo: params.repo,
        ref: `refs/heads/${params.branch}`,
        sha,
      }
    );

    return {
      ref: refData.ref,
      sha: refData.object.sha,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get an Octokit instance authenticated as the GitHub App installation
   * for the given owner/repo. Installation ID is cached per owner/repo.
   */
  private async getOctokit(owner: string, repo: string): Promise<Octokit> {
    const installationId = await this.resolveInstallationId(owner, repo);
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        installationId,
      },
    });
  }

  /**
   * Resolve GitHub App installation ID for a repo.
   * Cached per owner/repo to avoid redundant API calls.
   * Pattern from: services/scheduler-worker/src/adapters/ingestion/github-auth.ts:62-87
   */
  private async resolveInstallationId(
    owner: string,
    repo: string
  ): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationCache.get(cacheKey);
    if (cached) return cached;

    const { token } = await this.appAuth({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub App not installed on ${cacheKey} (HTTP ${response.status})`
      );
    }

    const data = (await response.json()) as { id: number };
    this.installationCache.set(cacheKey, data.id);
    return data.id;
  }
}
