// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/attribution/fake-github-registration`
 * Purpose: Fake DataSourceRegistration for stack tests — returns canned ActivityEvent[] without hitting GitHub API.
 * Scope: Test fixture only. Provides a factory for building fake registrations with deterministic, idempotent responses. Does not perform network I/O or access external APIs.
 * Invariants:
 *   - Same shape as real GitHubSourceAdapter registration (source, version, poll)
 *   - Events include metadata fields the promotion selection policy inspects (baseBranch, mergeCommitSha, commitShas)
 * Side-effects: none
 * Links: packages/ingestion-core/src/port.ts, tests/stack/attribution/collect-epoch-pipeline.stack.test.ts
 * @internal
 */

import type {
  ActivityEvent,
  CollectResult,
  DataSourceRegistration,
  StreamDefinition,
} from "@cogni/ingestion-core";

/** Canned streams matching the real GitHub adapter's output */
const FAKE_STREAMS: StreamDefinition[] = [
  {
    id: "pull_requests",
    name: "Pull Requests",
    cursorType: "timestamp",
    defaultPollInterval: 300,
  },
];

/**
 * Creates a fake GitHub DataSourceRegistration that returns canned events.
 * Every collect() call returns the same events — idempotency is handled by DB constraints.
 */
export function createFakeGitHubRegistration(
  cannedEvents: ActivityEvent[]
): DataSourceRegistration {
  return {
    source: "github",
    version: "0.0.0-test",
    poll: {
      streams: () => FAKE_STREAMS,
      collect: async (): Promise<CollectResult> => {
        return {
          events: cannedEvents,
          nextCursor: {
            streamId: "pull_requests",
            value: new Date().toISOString(),
            retrievedAt: new Date(),
          },
        };
      },
    },
  };
}

/**
 * Builds canned ActivityEvent[] that exercise the promotion selection policy:
 *
 * 1. Release PR (baseBranch=main) — contains commitShas of promoted staging PRs.
 *    This is reference data: included=false by the promotion policy.
 * 2. Staging PR #42 (baseBranch=staging) — mergeCommitSha in the release PR's commitShas → included=true.
 * 3. Staging PR #43 (baseBranch=staging) — mergeCommitSha in the release PR's commitShas → included=true.
 *
 * Total: 3 events. 2 should be selected (the staging PRs). 1 excluded (the release PR).
 */
export function makeCannedGitHubEvents(epochMidpoint: Date): ActivityEvent[] {
  const ts1 = new Date(epochMidpoint.getTime() - 3600_000); // 1h before midpoint
  const ts2 = new Date(epochMidpoint.getTime() - 1800_000); // 30min before
  const ts3 = new Date(epochMidpoint.getTime() - 600_000); // 10min before

  return [
    // Release PR merged to main — promotes staging PRs whose mergeCommitSha is in commitShas
    {
      id: "github:pr:test-org/test-repo:100",
      source: "github",
      eventType: "pr_merged",
      platformUserId: "99999",
      platformLogin: "release-bot",
      artifactUrl: "https://github.com/test-org/test-repo/pull/100",
      metadata: {
        title: "release: v1.0.0",
        baseBranch: "main",
        mergeCommitSha: "release-sha",
        commitShas: ["aaa111", "bbb222"], // ← promotes PR #42 and #43
      },
      payloadHash: "r".repeat(64),
      eventTime: ts3,
    },
    // Staging PR — mergeCommitSha "aaa111" is in release PR's commitShas → promoted
    {
      id: "github:pr:test-org/test-repo:42",
      source: "github",
      eventType: "pr_merged",
      platformUserId: "12345",
      platformLogin: "alice",
      artifactUrl: "https://github.com/test-org/test-repo/pull/42",
      metadata: {
        title: "feat: add feature",
        baseBranch: "staging",
        mergeCommitSha: "aaa111",
        commitShas: ["aaa111"],
        repo: "test-org/test-repo",
      },
      payloadHash: "a".repeat(64),
      eventTime: ts1,
    },
    // Staging PR — mergeCommitSha "bbb222" is in release PR's commitShas → promoted
    {
      id: "github:pr:test-org/test-repo:43",
      source: "github",
      eventType: "pr_merged",
      platformUserId: "67890",
      platformLogin: "bob",
      artifactUrl: "https://github.com/test-org/test-repo/pull/43",
      metadata: {
        title: "feat: another feature",
        baseBranch: "staging",
        mergeCommitSha: "bbb222",
        commitShas: ["bbb222"],
        repo: "test-org/test-repo",
      },
      payloadHash: "b".repeat(64),
      eventTime: ts2,
    },
  ];
}
