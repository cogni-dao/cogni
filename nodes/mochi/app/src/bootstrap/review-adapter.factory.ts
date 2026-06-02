// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review-adapter.factory`
 * Purpose: Create review adapter dependencies bound to a specific GitHub App installation.
 * Scope: Bootstrap composition — wires Octokit auth + adapter functions. Does not contain business logic.
 * Invariants: ARCHITECTURE_ALIGNMENT — only bootstrap imports adapters.
 * Side-effects: none (factory function, IO deferred to call sites)
 * Links: task.0153
 * @public
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCheckRun,
  updateCheckRun,
} from "@/adapters/server/review/check-run";
import { gatherEvidence } from "@/adapters/server/review/evidence-gatherer";
import { createInstallationOctokit } from "@/adapters/server/review/github-auth";
import { postPrComment } from "@/adapters/server/review/pr-comment";
import { serverEnv } from "@/shared/env";

/**
 * Create review adapter deps bound to a specific GitHub App installation.
 * Returns functions matching ReviewHandlerDeps shape (structural typing).
 */
export function createReviewAdapterDeps(
  installationId: number,
  appId: string,
  privateKeyBase64: string
) {
  const octokit = createInstallationOctokit(
    installationId,
    appId,
    privateKeyBase64
  );

  const repoRoot = serverEnv().COGNI_REPO_ROOT ?? "/nonexistent";

  return {
    createCheckRun: (owner: string, repo: string, headSha: string) =>
      createCheckRun(octokit, owner, repo, headSha),
    updateCheckRun: (
      owner: string,
      repo: string,
      checkRunId: number,
      conclusion: string,
      summary: string
    ) => updateCheckRun(octokit, owner, repo, checkRunId, conclusion, summary),
    gatherEvidence: (owner: string, repo: string, prNumber: number) =>
      gatherEvidence(octokit, owner, repo, prNumber),
    postPrComment: (
      owner: string,
      repo: string,
      prNumber: number,
      expectedHeadSha: string,
      body: string
    ) => postPrComment(octokit, owner, repo, prNumber, expectedHeadSha, body),
    readRepoSpec: () =>
      readFileSync(join(repoRoot, ".cogni", "repo-spec.yaml"), "utf-8"),
    readRuleFile: (ruleFile: string) =>
      readFileSync(join(repoRoot, ".cogni", "rules", ruleFile), "utf-8"),
  };
}
