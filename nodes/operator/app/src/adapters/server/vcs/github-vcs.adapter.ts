// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-vcs`
 * Purpose: VcsCapability adapter using Octokit + GitHub App authentication.
 * Scope: Implements VcsCapability for GitHub API operations (list PRs, CI status, merge, create branch, dispatch candidate-flight).
 * Invariants:
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
  CheckInfo,
  CiStatusResult,
  CreateBranchResult,
  DispatchCandidateFlightResult,
  DispatchNodeFlightResult,
  MergeResult,
  PrSummary,
  VcsCapability,
} from "@cogni/ai-tools";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubVcsAdapterConfig {
  readonly appId: string;
  readonly privateKey: string;
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
    const [checksResponse, statusResponse, reviewsResponse] = await Promise.all(
      [
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
      ]
    );

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

    // Gate on GitHub Actions check runs only — third-party app checks (SonarCloud, etc.)
    // are informational and do not block merge via branch protection.
    const ciChecks = [
      ...rawCheckRuns
        .filter((cr) => cr.app?.slug === "github-actions")
        .map((cr) => ({ status: cr.status, conclusion: cr.conclusion })),
      // Legacy commit statuses are always included (they are GitHub-native)
      ...(statusResponse.data.statuses as Array<{ state: string }>).map(
        (s) => ({
          status: "completed",
          conclusion:
            s.state === "success"
              ? "success"
              : s.state === "pending"
                ? null
                : "failure",
        })
      ),
    ];

    const pending = ciChecks.some(
      (c) => c.status !== "completed" || c.conclusion === null
    );
    const allGreen =
      ciChecks.length > 0 &&
      !pending &&
      ciChecks.every(
        (c) => c.conclusion === "success" || c.conclusion === "skipped"
      );

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
      mergeable: pr.mergeable,
      reviewDecision,
      labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name) ?? ""),
      draft: pr.draft ?? false,
      allGreen,
      pending,
      checks,
    };
  }

  async mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<MergeResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    try {
      const { data } = await octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
          merge_method: params.method,
        }
      );

      return {
        merged: data.merged,
        sha: data.sha,
        message: data.message,
      };
    } catch (error) {
      // GitHub returns 405 for already merged or not mergeable
      const message = error instanceof Error ? error.message : "Merge failed";
      return { merged: false, message };
    }
  }

  async dispatchCandidateFlight(params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha?: string;
    workflowRef?: string;
  }): Promise<DispatchCandidateFlightResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // workflow_dispatch inputs are always strings at the GitHub API boundary
    // even when the workflow declares `type: string` — LiteLLM / Octokit
    // preserves values as-is. We stringify prNumber explicitly.
    const inputs: Record<string, string> = {
      pr_number: String(params.prNumber),
    };
    if (params.headSha) {
      inputs.head_sha = params.headSha;
    }

    // GitHub returns HTTP 204 with no body on success. There is no run_id in
    // the response — do NOT attempt to correlate here; the caller observes
    // the resulting `candidate-flight` check on the PR head via getCiStatus.
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

    const shortSha = params.headSha ? params.headSha.slice(0, 8) : "HEAD";
    return {
      dispatched: true,
      prNumber: params.prNumber,
      headSha: params.headSha ?? null,
      workflowUrl,
      message: `Flight dispatched for PR #${params.prNumber} @ ${shortSha}. Observe via core__vcs_get_ci_status (look for 'candidate-flight' check).`,
    };
  }

  async commitExists(params: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<boolean> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    try {
      await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
      });
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async fetchFileText(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: params.ref ?? "main",
        }
      );
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
        return null;
      }
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async dispatchNodeFlight(params: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
    environment: "candidate-a" | "preview" | "production";
    workflowRef?: string;
  }): Promise<DispatchNodeFlightResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);
    const ref = params.workflowRef ?? "main";

    if (params.environment === "candidate-a") {
      await octokit.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          owner: params.owner,
          repo: params.repo,
          workflow_id: "candidate-flight.yml",
          ref,
          inputs: {
            node_slug: params.slug,
            source_sha: params.sourceSha,
          },
        }
      );

      return {
        dispatched: true,
        slug: params.slug,
        sourceSha: params.sourceSha,
        environment: params.environment,
        workflowUrl: `https://github.com/${params.owner}/${params.repo}/actions/workflows/candidate-flight.yml`,
        message: `Candidate flight dispatched for ${params.slug}@${params.sourceSha.slice(0, 8)}.`,
      };
    }

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: params.owner,
        repo: params.repo,
        workflow_id: "promote-and-deploy.yml",
        ref,
        inputs: {
          environment: params.environment,
          nodes: params.slug,
          build_sha: params.sourceSha,
          skip_infra: "false",
          deploy_infra_mode: "full",
        },
      }
    );

    return {
      dispatched: true,
      slug: params.slug,
      sourceSha: params.sourceSha,
      environment: params.environment,
      workflowUrl: `https://github.com/${params.owner}/${params.repo}/actions/workflows/promote-and-deploy.yml`,
      message: `${params.environment} promote dispatched for ${params.slug}@${params.sourceSha.slice(0, 8)}.`,
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
