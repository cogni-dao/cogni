// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/reviewed-workflow-ref`
 * Purpose: Resolve an optional workflow ref to the exact reviewed PR head containing main.
 * Scope: GitHub reads and a content-addressed ref; does not dispatch workflows.
 * Invariants:
 *   - DEFAULT_MAIN_UNCHANGED: callers invoke this only when workflowRef is explicitly present.
 *   - EXACT_REVIEWED_HEAD: workflowRef must resolve to sourceSha and sourceSha must be the exact
 *     head of an open same-repo PR to main.
 *   - CURRENT_MAIN_INCLUDED: an old reviewed PR cannot dispatch obsolete workflow writers.
 *   - CROSS_REPO_FAILS_CLOSED: fork PR heads are never accepted as workflow code.
 * Side-effects: IO (GitHub REST API reads)
 * Links: bug.5455, docs/spec/cicd-platform-boundary.md
 * @internal
 */

import type { Octokit } from "@octokit/core";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const WORKFLOW_REF_PATTERN =
  /^(?![0-9a-f]{40}$)(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))(?![./])(?!.*[./]$)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/i;

interface AssociatedPull {
  readonly number: number;
  readonly html_url: string;
  readonly state?: string;
  readonly draft?: boolean;
  readonly base?: { readonly ref?: string };
  readonly head?: {
    readonly sha?: string;
    readonly repo?: { readonly full_name?: string };
  };
}

export interface ReviewedWorkflowRef {
  readonly workflowRef: string;
  readonly resolvedSha: string;
  /** Operator-created, content-addressed branch used for workflow_dispatch. */
  readonly dispatchRef: string;
  readonly prNumber: number;
  readonly prUrl: string;
}

export class ReviewedWorkflowRefError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReviewedWorkflowRefError";
    this.code = code;
    this.status = status;
  }
}

export function isSafeWorkflowRef(value: string): boolean {
  return WORKFLOW_REF_PATTERN.test(value);
}

function githubStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { readonly status: unknown }).status === "number"
    ? (error as { readonly status: number }).status
    : undefined;
}

async function readWorkflowDispatchRef(input: {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly dispatchRef: string;
}): Promise<string | null> {
  try {
    const { data: ref } = await input.octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.dispatchRef}`,
      }
    );
    return ref.object.sha;
  } catch (error) {
    if (githubStatus(error) === 404) return null;
    throw error;
  }
}

async function ensureWorkflowDispatchRef(input: {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly sourceSha: string;
}): Promise<string> {
  const dispatchRef = `cogni-flight/${input.sourceSha.toLowerCase()}`;
  let existingSha = await readWorkflowDispatchRef({ ...input, dispatchRef });
  if (existingSha === null) {
    try {
      await input.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${dispatchRef}`,
        sha: input.sourceSha,
      });
      existingSha = input.sourceSha;
    } catch (error) {
      // A concurrent safe dispatcher may have created the same content-addressed ref after our
      // read. Re-read on 422 and verify it below; every other failure remains loud.
      if (githubStatus(error) !== 422) throw error;
      existingSha = await readWorkflowDispatchRef({ ...input, dispatchRef });
    }
  }
  if (
    existingSha === null ||
    existingSha.toLowerCase() !== input.sourceSha.toLowerCase()
  ) {
    throw new ReviewedWorkflowRefError(
      "workflow_dispatch_ref_mismatch",
      "content-addressed workflow dispatch ref exists at a different commit",
      409
    );
  }

  // Retention is deliberately content-addressed and non-destructive: refs are never updated and
  // are retained after dispatch. Deleting asynchronously used refs here would reintroduce a fetch
  // race; a future run-aware GC may delete only refs with no queued/running workflow.
  return dispatchRef;
}

export async function resolveReviewedWorkflowRef(input: {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly workflowRef: string;
  readonly sourceSha: string;
}): Promise<ReviewedWorkflowRef> {
  const { octokit, owner, repo, workflowRef, sourceSha } = input;
  if (!isSafeWorkflowRef(workflowRef)) {
    throw new ReviewedWorkflowRefError(
      "invalid_workflow_ref",
      "workflowRef must be a same-repository branch or tag name",
      400
    );
  }
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new ReviewedWorkflowRefError(
      "invalid_source_sha",
      "sourceSha must be a 40-character hex SHA",
      400
    );
  }

  let resolvedSha: string;
  try {
    const { data: commit } = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      { owner, repo, ref: workflowRef }
    );
    resolvedSha = commit.sha;
  } catch (error) {
    if (githubStatus(error) === 404 || githubStatus(error) === 422) {
      throw new ReviewedWorkflowRefError(
        "workflow_ref_not_found",
        `workflowRef was not found in ${owner}/${repo}`,
        422
      );
    }
    throw error;
  }

  if (
    !SOURCE_SHA_PATTERN.test(resolvedSha) ||
    resolvedSha.toLowerCase() !== sourceSha.toLowerCase()
  ) {
    throw new ReviewedWorkflowRefError(
      "workflow_ref_source_mismatch",
      "workflowRef must resolve exactly to sourceSha",
      422
    );
  }

  const { data: associatedPulls } = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
    { owner, repo, commit_sha: resolvedSha, per_page: 100 }
  );
  const matchingHeads = (associatedPulls as AssociatedPull[]).filter(
    (pr) =>
      pr.state === "open" &&
      pr.draft !== true &&
      pr.base?.ref === "main" &&
      pr.head?.sha?.toLowerCase() === resolvedSha.toLowerCase()
  );
  const expectedRepo = `${owner}/${repo}`.toLowerCase();
  const reviewedPr = matchingHeads.find(
    (pr) => pr.head?.repo?.full_name?.toLowerCase() === expectedRepo
  );
  if (!reviewedPr) {
    const isCrossRepo = matchingHeads.some(
      (pr) =>
        pr.head?.repo?.full_name !== undefined &&
        pr.head.repo.full_name.toLowerCase() !== expectedRepo
    );
    throw new ReviewedWorkflowRefError(
      isCrossRepo
        ? "workflow_ref_cross_repo_source"
        : "workflow_ref_unreviewed_source",
      isCrossRepo
        ? "workflowRef must be the head of a same-repository PR"
        : "workflowRef must be the exact head of an open same-repository PR to main",
      422
    );
  }

  // A reviewed open PR can still carry obsolete workflow writers. Require the
  // currently trusted main before minting a content ref or dispatching it.
  const { data: comparison } = await octokit.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    { owner, repo, basehead: `main...${resolvedSha}` }
  );
  if (comparison.status === "behind" || comparison.status === "diverged") {
    throw new ReviewedWorkflowRefError(
      "workflow_ref_missing_current_main",
      "workflowRef must contain current main; update the reviewed PR before flight",
      422
    );
  }
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new ReviewedWorkflowRefError(
      "workflow_ref_main_ancestry_unavailable",
      "GitHub did not establish workflowRef ancestry from current main",
      503
    );
  }

  const dispatchRef = await ensureWorkflowDispatchRef({
    octokit,
    owner,
    repo,
    sourceSha: resolvedSha,
  });

  return {
    workflowRef,
    resolvedSha,
    dispatchRef,
    prNumber: reviewedPr.number,
    prUrl: reviewedPr.html_url,
  };
}
