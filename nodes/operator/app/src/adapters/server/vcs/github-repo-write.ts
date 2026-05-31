// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write`
 * Purpose: Operator-only helper that commits a single file and opens a pull request via the GitHub App.
 * Scope: Two thin Octokit calls behind one entry point; reuses GitHub App installation auth (cogni-node-template).
 *   Does not belong in `VcsCapability` because that capability is shared with poly/resy/node-template stubs
 *   and these write ops are operator-only.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED: caller must verify the app is installed on the target repo; we surface a
 *     clear error if not. Public-repo install is sufficient for v0.
 *   - SINGLE_FILE_COMMIT: writes exactly one file path; no multi-file orchestration.
 *   - PR_AGAINST_BASE_REF: opens a PR with the given title/body against `baseRef`; never force-pushes.
 * Side-effects: IO (GitHub REST API)
 * Links: docs/spec/node-formation.md, task.5083
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

export interface GitHubRepoWriterConfig {
  readonly appId: string;
  readonly privateKey: string;
}

export interface CommitFileAndOpenPrInput {
  readonly owner: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly headBranch: string;
  readonly path: string;
  readonly content: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly prBody: string;
}

export interface CommitFileAndOpenPrResult {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
}

export class GitHubRepoWriter {
  private readonly config: GitHubRepoWriterConfig;
  private readonly appAuth: ReturnType<typeof createAppAuth>;

  constructor(config: GitHubRepoWriterConfig) {
    this.config = config;
    this.appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  async commitFileAndOpenPr(
    input: CommitFileAndOpenPrInput
  ): Promise<CommitFileAndOpenPrResult> {
    const octokit = await this.getOctokit(input.owner, input.repo);

    // 1. Resolve baseRef → sha (the parent commit for our new branch).
    const { data: baseRefData } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.baseRef}`,
      }
    );
    const baseSha = baseRefData.object.sha;

    // 2. Create the head branch from baseSha (idempotent: ignore "already exists").
    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${input.headBranch}`,
        sha: baseSha,
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
    }

    // 3. If the file already exists on headBranch, fetch its blob SHA so the
    //    contents API treats this as an update rather than rejecting.
    let existingSha: string | undefined;
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.headBranch,
        }
      );
      if (!Array.isArray(data) && data.type === "file") {
        existingSha = data.sha;
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 404) throw err;
    }

    // 4. Write the file (single-file commit).
    const { data: commitData } = await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        message: input.commitMessage,
        content: Buffer.from(input.content, "utf-8").toString("base64"),
        branch: input.headBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      }
    );

    const headSha = commitData.commit?.sha ?? "";

    // 5. Open the PR. If a PR for this head already exists, return it.
    try {
      const { data: pr } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          title: input.prTitle,
          body: input.prBody,
          head: input.headBranch,
          base: input.baseRef,
        }
      );
      return { prNumber: pr.number, prUrl: pr.html_url, headSha };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
      const { data: existing } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          state: "open",
          head: `${input.owner}:${input.headBranch}`,
          per_page: 1,
        }
      );
      if (existing.length === 0) {
        throw new Error(
          `Failed to open PR and no open PR found for head ${input.headBranch}`
        );
      }
      const pr = existing[0];
      if (!pr) {
        throw new Error(
          `Failed to open PR and no open PR found for head ${input.headBranch}`
        );
      }
      return {
        prNumber: pr.number,
        prUrl: pr.html_url,
        headSha,
      };
    }
  }

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

  private async resolveInstallationId(
    owner: string,
    repo: string
  ): Promise<number> {
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
        `GitHub App not installed on ${owner}/${repo} (HTTP ${response.status}). ` +
          `Install cogni-node-template on the target repo and retry.`
      );
    }
    const data = (await response.json()) as { id: number };
    return data.id;
  }
}
