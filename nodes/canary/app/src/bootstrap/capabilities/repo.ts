// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/repo`
 * Purpose: Factory for RepoCapability - composes GitLsFilesAdapter + RipgrepAdapter.
 * Scope: Creates RepoCapability from server environment. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: Repo path resolved from env, never passed to tools
 *   - SHA_SOURCE_OF_TRUTH: GitLsFilesAdapter owns getSha; RipgrepAdapter receives it
 * Side-effects: none (factory only)
 * Links: Called by bootstrap container; consumed by ai-tools repo tools.
 *        Uses env.COGNI_REPO_ROOT (resolved in server.ts).
 * @internal
 */

import type { RepoCapability } from "@cogni/ai-tools";

import { GitLsFilesAdapter, RipgrepAdapter } from "@/adapters/server";
import { FakeRepoAdapter } from "@/adapters/test";
import type { ServerEnv } from "@/shared/env";

/**
 * Stub RepoCapability that throws when not configured.
 */
export const stubRepoCapability: RepoCapability = {
  search: async () => {
    throw new Error(
      "RepoCapability not configured. Set COGNI_REPO_PATH or ensure rg is available."
    );
  },
  open: async () => {
    throw new Error(
      "RepoCapability not configured. Set COGNI_REPO_PATH or ensure rg is available."
    );
  },
  list: async () => {
    throw new Error(
      "RepoCapability not configured. Set COGNI_REPO_PATH or ensure git is available."
    );
  },
  getSha: async () => {
    throw new Error(
      "RepoCapability not configured. Set COGNI_REPO_PATH or ensure git is available."
    );
  },
};

/**
 * Create RepoCapability from server environment.
 *
 * Composes adapters by responsibility:
 * - GitLsFilesAdapter: git concerns (SHA resolution, file listing)
 * - RipgrepAdapter: search + file open (receives getSha from git adapter)
 *
 * - APP_ENV=test: FakeRepoAdapter (deterministic, no subprocess)
 * - Otherwise: Composite of GitLsFilesAdapter + RipgrepAdapter
 *
 * @param env - Server environment
 * @returns RepoCapability backed by appropriate adapters
 */
export function createRepoCapability(env: ServerEnv): RepoCapability {
  if (!env.COGNI_REPO_ROOT) {
    return stubRepoCapability;
  }

  if (env.isTestMode) {
    const fake = new FakeRepoAdapter();
    return {
      search: (p) => fake.search(p),
      open: (p) => fake.open(p),
      list: (p) => fake.list(p),
      getSha: () => fake.getSha(),
    };
  }

  // GitLsFilesAdapter owns git concerns: SHA resolution + file listing
  const gitAdapter = new GitLsFilesAdapter({
    repoRoot: env.COGNI_REPO_ROOT,
    shaOverride: env.COGNI_REPO_SHA,
  });

  // RipgrepAdapter owns rg concerns: search + file open
  // Receives getSha from git adapter (single source of truth)
  const rgAdapter = new RipgrepAdapter({
    repoRoot: env.COGNI_REPO_ROOT,
    repoId: "main",
    getSha: () => gitAdapter.getSha(),
  });

  return {
    search: (p) => rgAdapter.search(p),
    open: (p) => rgAdapter.open(p),
    list: (p) => gitAdapter.list(p),
    getSha: () => gitAdapter.getSha(),
  };
}
