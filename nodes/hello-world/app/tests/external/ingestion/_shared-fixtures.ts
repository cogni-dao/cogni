// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/ingestion/_shared-fixtures`
 * Purpose: Lazy singleton GitHub fixtures shared across external ingestion test files.
 * Scope: Creates one merged PR + one closed issue per test run instead of per file. Does NOT run in CI.
 * Invariants: Requires singleFork pool (vitest.external.config.mts) for cross-file sharing.
 * Side-effects: IO (GitHub API on first access)
 * Links: tests/external/ingestion/_github-fixture-helper.ts
 * @internal
 */

import {
  cleanupFixtures,
  createFixtures,
  type GitHubFixtures,
} from "./_github-fixture-helper";

const TEST_REPO = process.env.E2E_GITHUB_REPO ?? "derekg1729/test-repo";

let _fixtures: GitHubFixtures | null = null;
let _refCount = 0;

export function acquireSharedFixtures(): GitHubFixtures {
  if (!_fixtures) {
    _fixtures = createFixtures(TEST_REPO);
  }
  _refCount++;
  return _fixtures;
}

export function releaseSharedFixtures(): void {
  _refCount--;
  if (_refCount <= 0 && _fixtures) {
    cleanupFixtures(_fixtures);
    _fixtures = null;
  }
}
