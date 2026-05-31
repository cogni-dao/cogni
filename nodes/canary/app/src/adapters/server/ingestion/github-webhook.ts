// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ingestion/github-webhook`
 * Purpose: GitHub webhook normalizer — verifies signature and normalizes webhook payloads to ActivityEvent[].
 * Scope: Implements WebhookNormalizer from @cogni/ingestion-core. Uses @octokit/webhooks-methods for HMAC-SHA256 verification. Does not perform HTTP I/O or hold mutable state.
 * Invariants:
 * - WEBHOOK_VERIFY_VIA_OSS: Signature verification via @octokit/webhooks-methods (not bespoke crypto)
 * - WEBHOOK_VERIFY_BEFORE_NORMALIZE: verify() must be called before normalize() — enforced by feature service
 * - ACTIVITY_IDEMPOTENT: Deterministic event IDs from source data (same as poll adapter)
 * - INGEST_ALL_FILTER_LATER: Normalizer captures all actionable events; downstream selection decides what's attributable
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md
 * @internal
 */

import type { ActivityEvent, WebhookNormalizer } from "@cogni/ingestion-core";
import {
  buildEventId,
  GITHUB_ADAPTER_VERSION,
  hashCanonicalPayload,
} from "@cogni/ingestion-core";
import { verify } from "@octokit/webhooks-methods";

export { GITHUB_ADAPTER_VERSION };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitHubUser {
  id: number;
  login: string;
  type: string;
}

/**
 * Extract actor from a webhook payload. Returns null for bots/mannequins.
 * Bot filtering is a data-quality concern (bots don't have stable numeric IDs),
 * not a selection concern.
 */
function extractActor(
  user: Record<string, unknown> | null | undefined
): { id: string; login: string } | null {
  if (!user) return null;
  const typed = user as unknown as GitHubUser;
  if (typed.type !== "User") return null;
  if (!typed.id) return null;
  return { id: String(typed.id), login: typed.login };
}

function repoFullName(payload: Record<string, unknown>): string | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  return (repo?.full_name as string) ?? null;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * GitHub webhook normalizer.
 * Captures all actionable GitHub events — downstream selection decides what's attributable.
 * Uses @octokit/webhooks-methods for HMAC-SHA256 signature verification.
 */
export class GitHubWebhookNormalizer implements WebhookNormalizer {
  readonly supportedEvents = [
    "pull_request",
    "pull_request_review",
    "issues",
    "issue_comment",
    "push",
  ] as const satisfies readonly string[];

  async verify(
    headers: Record<string, string>,
    body: Buffer,
    secret: string
  ): Promise<boolean> {
    const signature = headers["x-hub-signature-256"];
    if (!signature) return false;

    try {
      return await verify(secret, body.toString("utf-8"), signature);
    } catch {
      return false;
    }
  }

  async normalize(
    headers: Record<string, string>,
    body: unknown
  ): Promise<ActivityEvent[]> {
    const eventType = headers["x-github-event"];
    const payload = body as Record<string, unknown>;

    switch (eventType) {
      case "pull_request":
        return this.normalizePullRequest(payload);
      case "pull_request_review":
        return this.normalizePullRequestReview(payload);
      case "issues":
        return this.normalizeIssue(payload);
      case "issue_comment":
        return this.normalizeIssueComment(payload);
      case "push":
        return this.normalizePush(payload);
      default:
        // Events we don't have a specific normalizer for are dropped.
        // Add normalizers here as we expand ingestion coverage.
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Pull Request — all actions (opened, closed/merged, reopened, etc.)
  // -------------------------------------------------------------------------

  private async normalizePullRequest(
    payload: Record<string, unknown>
  ): Promise<ActivityEvent[]> {
    const action = payload.action as string;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr) return [];

    const fullName = repoFullName(payload);
    if (!fullName) return [];

    const actor = extractActor(pr.user as Record<string, unknown>);
    if (!actor) return [];

    const prNumber = pr.number as number;
    const isMerged = action === "closed" && pr.merged === true;

    // Determine the canonical event type and timestamp
    const eventType = isMerged ? "pr_merged" : `pr_${action}`;
    const eventTime = isMerged
      ? (pr.merged_at as string)
      : ((pr.updated_at as string) ?? (pr.created_at as string));

    if (!eventTime) return [];

    const id = isMerged
      ? buildEventId("github", "pr", fullName, prNumber)
      : buildEventId("github", "pr", fullName, prNumber, action);

    const payloadHash = await hashCanonicalPayload({
      authorId: actor.id,
      id,
      eventTime,
    });

    const base = pr.base as Record<string, unknown> | undefined;

    return [
      {
        id,
        source: "github",
        eventType,
        platformUserId: actor.id,
        platformLogin: actor.login,
        artifactUrl: pr.html_url as string,
        metadata: {
          title: pr.title as string,
          baseBranch: (base?.ref as string) ?? null,
          mergeCommitSha: isMerged
            ? ((pr.merge_commit_sha as string) ?? null)
            : null,
          repo: fullName,
          action,
          ...(pr.additions != null
            ? { additions: pr.additions as number }
            : {}),
          ...(pr.deletions != null
            ? { deletions: pr.deletions as number }
            : {}),
          ...(pr.changed_files != null
            ? { changedFiles: pr.changed_files as number }
            : {}),
        },
        payloadHash,
        eventTime: new Date(eventTime),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Pull Request Review — submitted, edited, dismissed
  // -------------------------------------------------------------------------

  private async normalizePullRequestReview(
    payload: Record<string, unknown>
  ): Promise<ActivityEvent[]> {
    const action = payload.action as string;
    if (action !== "submitted") return [];

    const review = payload.review as Record<string, unknown> | undefined;
    if (!review) return [];

    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr) return [];

    const fullName = repoFullName(payload);
    if (!fullName) return [];

    const actor = extractActor(review.user as Record<string, unknown>);
    if (!actor) return [];

    const prNumber = pr.number as number;
    const reviewId = review.id as number;
    const submittedAt = review.submitted_at as string;
    if (!submittedAt) return [];

    const id = buildEventId("github", "review", fullName, prNumber, reviewId);

    const payloadHash = await hashCanonicalPayload({
      authorId: actor.id,
      id,
      state: review.state as string,
      submittedAt,
    });

    const base = pr.base as Record<string, unknown> | undefined;

    return [
      {
        id,
        source: "github",
        eventType: "review_submitted",
        platformUserId: actor.id,
        platformLogin: actor.login,
        artifactUrl: review.html_url as string,
        metadata: {
          prNumber,
          prBaseBranch: (base?.ref as string) ?? null,
          state: review.state as string,
          repo: fullName,
        },
        payloadHash,
        eventTime: new Date(submittedAt),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Issues — all actions (opened, closed, reopened, labeled, etc.)
  // -------------------------------------------------------------------------

  private async normalizeIssue(
    payload: Record<string, unknown>
  ): Promise<ActivityEvent[]> {
    const action = payload.action as string;
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue) return [];

    const fullName = repoFullName(payload);
    if (!fullName) return [];

    const actor = extractActor(issue.user as Record<string, unknown>);
    if (!actor) return [];

    const issueNumber = issue.number as number;
    const isClosed = action === "closed";

    const eventType = isClosed ? "issue_closed" : `issue_${action}`;
    const eventTime = isClosed
      ? (issue.closed_at as string)
      : ((issue.updated_at as string) ?? (issue.created_at as string));

    if (!eventTime) return [];

    const id = isClosed
      ? buildEventId("github", "issue", fullName, issueNumber)
      : buildEventId("github", "issue", fullName, issueNumber, action);

    const payloadHash = await hashCanonicalPayload({
      authorId: actor.id,
      id,
      eventTime,
    });

    return [
      {
        id,
        source: "github",
        eventType,
        platformUserId: actor.id,
        platformLogin: actor.login,
        artifactUrl: issue.html_url as string,
        metadata: {
          title: issue.title as string,
          repo: fullName,
          action,
        },
        payloadHash,
        eventTime: new Date(eventTime),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Issue Comment — created (on issues and PRs)
  // -------------------------------------------------------------------------

  private async normalizeIssueComment(
    payload: Record<string, unknown>
  ): Promise<ActivityEvent[]> {
    const action = payload.action as string;
    if (action !== "created") return [];

    const comment = payload.comment as Record<string, unknown> | undefined;
    if (!comment) return [];

    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue) return [];

    const fullName = repoFullName(payload);
    if (!fullName) return [];

    const actor = extractActor(comment.user as Record<string, unknown>);
    if (!actor) return [];

    const commentId = comment.id as number;
    const createdAt = comment.created_at as string;
    if (!createdAt) return [];

    const id = buildEventId("github", "comment", fullName, commentId);

    const payloadHash = await hashCanonicalPayload({
      authorId: actor.id,
      id,
      createdAt,
    });

    return [
      {
        id,
        source: "github",
        eventType: "comment_created",
        platformUserId: actor.id,
        platformLogin: actor.login,
        artifactUrl: comment.html_url as string,
        metadata: {
          issueNumber: issue.number as number,
          repo: fullName,
        },
        payloadHash,
        eventTime: new Date(createdAt),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Push — commits pushed to a branch
  // -------------------------------------------------------------------------

  private async normalizePush(
    payload: Record<string, unknown>
  ): Promise<ActivityEvent[]> {
    const fullName = repoFullName(payload);
    if (!fullName) return [];

    const sender = payload.sender as Record<string, unknown> | undefined;
    const actor = extractActor(sender);
    if (!actor) return [];

    const ref = payload.ref as string;
    const after = payload.after as string;
    const commits = payload.commits as
      | Array<Record<string, unknown>>
      | undefined;
    const commitCount = commits?.length ?? 0;

    if (!after || after === "0000000000000000000000000000000000000000")
      return [];

    const id = buildEventId("github", "push", fullName, after);

    const payloadHash = await hashCanonicalPayload({
      authorId: actor.id,
      id,
      after,
    });

    const headCommit = payload.head_commit as
      | Record<string, unknown>
      | undefined;
    const eventTime = headCommit?.timestamp as string | undefined;
    if (!eventTime) return [];

    return [
      {
        id,
        source: "github",
        eventType: "push",
        platformUserId: actor.id,
        platformLogin: actor.login,
        artifactUrl: `https://github.com/${fullName}/commit/${after}`,
        metadata: {
          ref,
          after,
          commitCount,
          repo: fullName,
        },
        payloadHash,
        eventTime: new Date(eventTime),
      },
    ];
  }
}
