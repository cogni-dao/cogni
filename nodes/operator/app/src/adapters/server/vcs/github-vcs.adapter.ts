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
  OperatorChangeVerificationResult,
  PrSummary,
  VcsCapability,
} from "@cogni/ai-tools";
import { renderDeploymentActivationSpec } from "@cogni/repo-spec";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { parse as parseYaml } from "yaml";
import {
  classifyOperatorChangeForMerge,
  type OperatorChangeFacts,
  parseOperatorChangeRegistry,
} from "@/shared/vcs/operator-change-policy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubVcsAdapterConfig {
  readonly appId: string;
  readonly privateKey: string;
  /** Trusted repository whose main branch owns generated-change policy. */
  readonly operatorChangePolicyOwner?: string;
  readonly operatorChangePolicyRepo?: string;
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
      app: { slug: string } | null;
    }>;

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

    // Index GitHub-native check producers by context name — github-actions check
    // runs (by name) + legacy commit statuses (by context). Third-party app checks
    // (SonarCloud, etc.) are informational and never gate a merge.
    const byContext = new Map<
      string,
      { status: string; conclusion: string | null }
    >();
    for (const cr of rawCheckRuns) {
      if (cr.app?.slug === "github-actions") {
        byContext.set(cr.name, {
          status: cr.status,
          conclusion: cr.conclusion,
        });
      }
    }
    for (const s of statusResponse.data.statuses as Array<{
      context: string;
      state: string;
    }>) {
      byContext.set(s.context, {
        status: "completed",
        conclusion:
          s.state === "success"
            ? "success"
            : s.state === "pending"
              ? null
              : "failure",
      });
    }

    // REQUIRED_CHECKS_ARE_GITHUB_DEFINED: "green" is GitHub's OWN required-status-
    // check set for the PR's base branch (from classic protection + active
    // rulesets), never an operator-invented list. A required context is satisfied
    // iff it completed
    // success|skipped — GitHub's own rule (a required check that legitimately
    // skips, e.g. a fork-guarded build, is passing). An unprotected branch (no
    // required checks) is NOT green: merge-on-green is meaningless without a
    // required set, so it fails closed.
    const requiredContexts = await this.getRequiredContexts(
      octokit,
      params.owner,
      params.repo,
      pr.base.ref
    );
    const pending = requiredContexts.some((ctx) => {
      const c = byContext.get(ctx);
      return !c || c.status !== "completed" || c.conclusion === null;
    });
    const allGreen =
      requiredContexts.length > 0 &&
      requiredContexts.every((ctx) => {
        const c = byContext.get(ctx);
        return (
          c != null &&
          c.status === "completed" &&
          (c.conclusion === "success" || c.conclusion === "skipped")
        );
      });

    // Compute review decision from individual reviews.
    // Take the latest review per reviewer; if any APPROVED and none CHANGES_REQUESTED → approved.
    const latestByReviewer = new Map<string, string>();
    for (const review of reviewsResponse.data as Array<{
      user: { login: string } | null;
      state: string;
    }>) {
      if (review.user && review.state !== "COMMENTED") {
        latestByReviewer.set(review.user.login, review.state);
      }
    }
    const reviewStates = [...latestByReviewer.values()];
    let reviewDecision: string | null = null;
    if (reviewStates.includes("CHANGES_REQUESTED")) {
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
    const facts: OperatorChangeFacts = {
      repository: `${params.owner}/${params.repo}`,
      expectedHeadSha: params.expectedHeadSha,
      pr: {
        state: pr.state,
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

    const structural = classifyOperatorChangeForMerge(facts);
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
      baseSha,
      headSha,
      operation: structural.operation,
      node: structural.node,
      files: facts.files.map((file) => file.filename),
    });
    return classifyOperatorChangeForMerge({
      ...facts,
      operationReplayVerified,
    });
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
  }): Promise<boolean> {
    // The child-repository operation has a compact complete replay: one stock
    // repo-spec splice plus an exact parent-catalog source_repo binding. Parent
    // operations stay disabled until their shared generator plans are callable
    // here; enabling their registry entry before then remains fail-closed.
    if (
      input.operation !== "deployment.declare" ||
      input.files.length !== 1 ||
      input.files[0] !== ".cogni/repo-spec.yaml" ||
      !this.config.operatorChangePolicyOwner ||
      !this.config.operatorChangePolicyRepo
    ) {
      return false;
    }
    const [baseSpec, headSpec, catalog] = await Promise.all([
      this.readFileText(
        input.targetOctokit,
        input.owner,
        input.repo,
        ".cogni/repo-spec.yaml",
        input.baseSha
      ),
      this.readFileText(
        input.targetOctokit,
        input.owner,
        input.repo,
        ".cogni/repo-spec.yaml",
        input.headSha
      ),
      this.readFileText(
        input.policyOctokit,
        this.config.operatorChangePolicyOwner,
        this.config.operatorChangePolicyRepo,
        `infra/catalog/${input.node}.yaml`,
        "main"
      ),
    ]);
    if (baseSpec === null || headSpec === null || catalog === null) return false;
    let parsedCatalog: unknown;
    try {
      parsedCatalog = parseYaml(catalog);
    } catch {
      return false;
    }
    if (
      parsedCatalog === null ||
      typeof parsedCatalog !== "object" ||
      Array.isArray(parsedCatalog)
    ) {
      return false;
    }
    const row = parsedCatalog as Record<string, unknown>;
    const expectedSourceRepo = `https://github.com/${input.owner}/${input.repo}.git`;
    if (
      row.name !== input.node ||
      typeof row.source_repo !== "string" ||
      row.source_repo.toLowerCase() !== expectedSourceRepo.toLowerCase()
    ) {
      return false;
    }
    return renderDeploymentActivationSpec(baseSpec) === headSpec;
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
   * policy is their union; spawned nodes use the rulesets path. Returns `[]` when
   * neither system requires checks, which the merge gate treats as not-green /
   * fail-closed. The active-rules endpoint includes repository + organization
   * rules and needs only metadata:read.
   */
  private async getRequiredContexts(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string[]> {
    const contexts = new Set<string>();
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
        { owner, repo, branch }
      );
      for (const context of data.contexts ?? []) contexts.add(context);
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }

    const { data: activeRules } = await octokit.request(
      "GET /repos/{owner}/{repo}/rules/branches/{branch}",
      { owner, repo, branch, per_page: 100 }
    );
    for (const rule of activeRules as ReadonlyArray<{
      type?: string;
      parameters?: {
        required_status_checks?: ReadonlyArray<{ context?: string }>;
      };
    }>) {
      if (rule.type !== "required_status_checks") continue;
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (check.context) contexts.add(check.context);
      }
    }
    return [...contexts];
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
   * MERGED_XOR_ENQUEUED: the merge gate (caller) has already asserted the PR is
   * green; this method only chooses the execution path by queue requirement. A caller that has
   * already proved a narrower signed change type may request `bypassQueue`; in that case the App
   * uses the ordinary merge endpoint and GitHub independently enforces that the App is an allowed
   * ruleset bypass actor. Every direct merge also sends `expectedHeadSha`; GitHub rejects the
   * request if the PR head moved after the caller's CI read. Required classic-protection checks
   * still apply.
   */
  async mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
    expectedHeadSha: string;
    bypassQueue?: boolean;
  }): Promise<MergeResult> {
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

    const queueEnabled = params.bypassQueue
      ? false
      : await this.isMergeQueueEnabled(
          octokit,
          params.owner,
          params.repo,
          baseRef
        );

    if (queueEnabled) {
      try {
        await this.enableAutoMerge(octokit, prNodeId, params.method);
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
   * returns a non-null node when one exists. Fail-open to `false` (direct merge)
   * if the query errors — never block a merge on a flaky discovery call.
   */
  private async isMergeQueueEnabled(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<boolean> {
    try {
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
    } catch {
      return false;
    }
  }

  /** Enable auto-merge on a PR (routes through the merge queue when required). */
  private async enableAutoMerge(
    octokit: Octokit,
    pullRequestId: string,
    method: "squash" | "merge" | "rebase"
  ): Promise<void> {
    const mergeMethod = method.toUpperCase(); // GraphQL PullRequestMergeMethod
    await octokit.graphql(
      `mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { id state }
        }
      }`,
      { pullRequestId, mergeMethod }
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
