// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ingestion/github-webhook-normalizer`
 * Purpose: Unit tests for GitHubWebhookNormalizer — verify() signature validation and normalize() payload parsing.
 * Scope: Covers pull_request (all actions), pull_request_review, issues (all actions), issue_comment, push, unsupported events, bot filtering. Does NOT test HTTP transport or feature service integration.
 * Invariants: WEBHOOK_VERIFY_VIA_OSS (uses @octokit/webhooks-methods for real HMAC-SHA256 signing in fixtures)
 * Side-effects: none
 * Links: src/adapters/server/ingestion/github-webhook.ts
 * @public
 */

import { sign } from "@octokit/webhooks-methods";
import { describe, expect, it } from "vitest";

import { GitHubWebhookNormalizer } from "@/adapters/server/ingestion/github-webhook";

// ---------------------------------------------------------------------------
// Helpers — payload shapes match real GitHub webhook fixtures
// See: cogni-git-review/fixtures/github/pull_request/*.json
// ---------------------------------------------------------------------------

const SECRET = "test-webhook-secret";

function makeHeaders(
  event: string,
  _body: string,
  signature?: string
): Record<string, string> {
  const h: Record<string, string> = { "x-github-event": event };
  if (signature) h["x-hub-signature-256"] = signature;
  return h;
}

async function signPayload(body: string): Promise<string> {
  return sign(SECRET, body);
}

function makePrPayload(overrides?: Record<string, unknown>) {
  return {
    action: "closed",
    pull_request: {
      number: 42,
      merged: true,
      merged_at: "2026-01-15T10:30:00Z",
      created_at: "2026-01-14T09:00:00Z",
      updated_at: "2026-01-15T10:30:00Z",
      title: "Add feature X",
      html_url: "https://github.com/test/repo/pull/42",
      additions: 100,
      deletions: 20,
      changed_files: 5,
      user: { id: 12345, login: "testuser", type: "User" },
    },
    repository: { full_name: "test/repo" },
    sender: { id: 12345, login: "testuser", type: "User" },
    ...overrides,
  };
}

function makeIssuePayload(overrides?: Record<string, unknown>) {
  return {
    action: "closed",
    issue: {
      number: 7,
      closed_at: "2026-01-15T11:00:00Z",
      created_at: "2026-01-10T08:00:00Z",
      updated_at: "2026-01-15T11:00:00Z",
      title: "Fix bug Y",
      html_url: "https://github.com/test/repo/issues/7",
      user: { id: 67890, login: "issueuser", type: "User" },
    },
    repository: { full_name: "test/repo" },
    ...overrides,
  };
}

function makeReviewPayload(overrides?: Record<string, unknown>) {
  return {
    action: "submitted",
    review: {
      id: 999,
      state: "approved",
      submitted_at: "2026-01-15T12:00:00Z",
      html_url: "https://github.com/test/repo/pull/42#pullrequestreview-999",
      user: { id: 11111, login: "reviewer", type: "User" },
    },
    pull_request: {
      number: 42,
      html_url: "https://github.com/test/repo/pull/42",
    },
    repository: { full_name: "test/repo" },
    ...overrides,
  };
}

function makeCommentPayload(overrides?: Record<string, unknown>) {
  return {
    action: "created",
    comment: {
      id: 555,
      created_at: "2026-01-15T13:00:00Z",
      html_url: "https://github.com/test/repo/issues/7#issuecomment-555",
      user: { id: 12345, login: "testuser", type: "User" },
    },
    issue: {
      number: 7,
    },
    repository: { full_name: "test/repo" },
    ...overrides,
  };
}

function makePushPayload(overrides?: Record<string, unknown>) {
  return {
    ref: "refs/heads/main",
    after: "abc123def456",
    commits: [{ id: "abc123def456", message: "fix something" }],
    head_commit: {
      timestamp: "2026-01-15T14:00:00Z",
    },
    repository: { full_name: "test/repo" },
    sender: { id: 12345, login: "testuser", type: "User" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubWebhookNormalizer", () => {
  const normalizer = new GitHubWebhookNormalizer();

  // -----------------------------------------------------------------------
  // verify()
  // -----------------------------------------------------------------------

  describe("verify()", () => {
    it("returns true for valid signature", async () => {
      const body = JSON.stringify(makePrPayload());
      const sig = await signPayload(body);
      const headers = makeHeaders("pull_request", body, sig);

      const result = await normalizer.verify(
        headers,
        Buffer.from(body),
        SECRET
      );
      expect(result).toBe(true);
    });

    it("returns false for invalid signature", async () => {
      const body = JSON.stringify(makePrPayload());
      const headers = makeHeaders("pull_request", body, "sha256=invalid");

      const result = await normalizer.verify(
        headers,
        Buffer.from(body),
        SECRET
      );
      expect(result).toBe(false);
    });

    it("returns false when signature header is missing", async () => {
      const body = JSON.stringify(makePrPayload());
      const headers = makeHeaders("pull_request", body);

      const result = await normalizer.verify(
        headers,
        Buffer.from(body),
        SECRET
      );
      expect(result).toBe(false);
    });

    it("returns false when body has been tampered", async () => {
      const body = JSON.stringify(makePrPayload());
      const sig = await signPayload(body);
      const headers = makeHeaders("pull_request", body, sig);
      const tampered = JSON.stringify({ ...makePrPayload(), action: "opened" });

      const result = await normalizer.verify(
        headers,
        Buffer.from(tampered),
        SECRET
      );
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — pull_request
  // -----------------------------------------------------------------------

  describe("normalize() — pull_request", () => {
    it("produces pr_merged event for merged PR", async () => {
      const payload = makePrPayload();
      const headers = makeHeaders("pull_request", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);

      const e = events[0];
      expect(e.id).toBe("github:pr:test/repo:42");
      expect(e.source).toBe("github");
      expect(e.eventType).toBe("pr_merged");
      expect(e.platformUserId).toBe("12345");
      expect(e.platformLogin).toBe("testuser");
      expect(e.artifactUrl).toBe("https://github.com/test/repo/pull/42");
      expect(e.payloadHash).toBeTruthy();
      expect(e.eventTime).toEqual(new Date("2026-01-15T10:30:00Z"));
      expect(e.metadata).toMatchObject({
        title: "Add feature X",
        repo: "test/repo",
        action: "closed",
        additions: 100,
        deletions: 20,
        changedFiles: 5,
      });
    });

    it("produces pr_opened event for opened PR", async () => {
      const payload = makePrPayload({ action: "opened" });
      (payload.pull_request as Record<string, unknown>).merged = false;
      (payload.pull_request as Record<string, unknown>).merged_at = null;
      const headers = makeHeaders("pull_request", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("pr_opened");
      expect(events[0].id).toBe("github:pr:test/repo:42:opened");
    });

    it("produces pr_closed event for unmerged closed PR", async () => {
      const payload = makePrPayload();
      (payload.pull_request as Record<string, unknown>).merged = false;
      (payload.pull_request as Record<string, unknown>).merged_at = null;
      const headers = makeHeaders("pull_request", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("pr_closed");
      expect(events[0].id).toBe("github:pr:test/repo:42:closed");
    });

    it("skips bot authors", async () => {
      const payload = makePrPayload();
      (payload.pull_request as Record<string, unknown>).user = {
        id: 99,
        login: "dependabot[bot]",
        type: "Bot",
      };
      const headers = makeHeaders("pull_request", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — pull_request_review
  // -----------------------------------------------------------------------

  describe("normalize() — pull_request_review", () => {
    it("produces review_submitted event", async () => {
      const payload = makeReviewPayload();
      const headers = makeHeaders("pull_request_review", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);

      const e = events[0];
      expect(e.id).toBe("github:review:test/repo:42:999");
      expect(e.eventType).toBe("review_submitted");
      expect(e.platformUserId).toBe("11111");
      expect(e.platformLogin).toBe("reviewer");
      expect(e.metadata).toMatchObject({
        prNumber: 42,
        state: "approved",
        repo: "test/repo",
      });
    });

    it("skips non-submitted review actions", async () => {
      const payload = makeReviewPayload({ action: "edited" });
      const headers = makeHeaders("pull_request_review", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });

    it("skips bot reviewers", async () => {
      const payload = makeReviewPayload();
      (payload.review as Record<string, unknown>).user = {
        id: 99,
        login: "bot",
        type: "Bot",
      };
      const headers = makeHeaders("pull_request_review", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — issues
  // -----------------------------------------------------------------------

  describe("normalize() — issues", () => {
    it("produces issue_closed event", async () => {
      const payload = makeIssuePayload();
      const headers = makeHeaders("issues", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);

      const e = events[0];
      expect(e.id).toBe("github:issue:test/repo:7");
      expect(e.eventType).toBe("issue_closed");
      expect(e.platformUserId).toBe("67890");
      expect(e.platformLogin).toBe("issueuser");
      expect(e.eventTime).toEqual(new Date("2026-01-15T11:00:00Z"));
    });

    it("produces issue_opened event", async () => {
      const payload = makeIssuePayload({ action: "opened" });
      (payload.issue as Record<string, unknown>).closed_at = null;
      const headers = makeHeaders("issues", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("issue_opened");
      expect(events[0].id).toBe("github:issue:test/repo:7:opened");
    });

    it("skips bot authors on issues", async () => {
      const payload = makeIssuePayload();
      (payload.issue as Record<string, unknown>).user = {
        id: 99,
        login: "bot",
        type: "Bot",
      };
      const headers = makeHeaders("issues", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — issue_comment
  // -----------------------------------------------------------------------

  describe("normalize() — issue_comment", () => {
    it("produces comment_created event", async () => {
      const payload = makeCommentPayload();
      const headers = makeHeaders("issue_comment", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);

      const e = events[0];
      expect(e.id).toBe("github:comment:test/repo:555");
      expect(e.eventType).toBe("comment_created");
      expect(e.platformUserId).toBe("12345");
      expect(e.metadata).toMatchObject({
        issueNumber: 7,
        repo: "test/repo",
      });
    });

    it("skips non-created comment actions", async () => {
      const payload = makeCommentPayload({ action: "deleted" });
      const headers = makeHeaders("issue_comment", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — push
  // -----------------------------------------------------------------------

  describe("normalize() — push", () => {
    it("produces push event", async () => {
      const payload = makePushPayload();
      const headers = makeHeaders("push", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(1);

      const e = events[0];
      expect(e.id).toBe("github:push:test/repo:abc123def456");
      expect(e.eventType).toBe("push");
      expect(e.platformUserId).toBe("12345");
      expect(e.metadata).toMatchObject({
        ref: "refs/heads/main",
        after: "abc123def456",
        commitCount: 1,
        repo: "test/repo",
      });
    });

    it("skips delete pushes (null SHA)", async () => {
      const payload = makePushPayload({
        after: "0000000000000000000000000000000000000000",
      });
      const headers = makeHeaders("push", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });

    it("skips bot senders", async () => {
      const payload = makePushPayload({
        sender: { id: 99, login: "github-actions[bot]", type: "Bot" },
      });
      const headers = makeHeaders("push", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });

    it("skips pushes without head_commit timestamp", async () => {
      const payload = makePushPayload({ head_commit: null });
      const headers = makeHeaders("push", "");

      const events = await normalizer.normalize(headers, payload);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // normalize() — unsupported events
  // -----------------------------------------------------------------------

  describe("normalize() — unsupported events", () => {
    it("returns empty array for unknown event types", async () => {
      const headers = makeHeaders("star", "");
      const events = await normalizer.normalize(headers, { action: "created" });
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // supportedEvents
  // -----------------------------------------------------------------------

  describe("supportedEvents", () => {
    it("lists all supported event types", () => {
      expect(normalizer.supportedEvents).toContain("pull_request");
      expect(normalizer.supportedEvents).toContain("pull_request_review");
      expect(normalizer.supportedEvents).toContain("issues");
      expect(normalizer.supportedEvents).toContain("issue_comment");
      expect(normalizer.supportedEvents).toContain("push");
    });
  });
});
