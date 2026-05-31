// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test/repo/fake-repo.adapter`
 * Purpose: Fake repo adapter for testing.
 * Scope: Returns deterministic mock results. Does NOT spawn rg or git.
 * Invariants:
 *   - DETERMINISTIC_RESULTS: Always returns same structure for same query
 *   - NO_SUBPROCESS: Never spawns child processes
 * Side-effects: none
 * Links: COGNI_BRAIN_SPEC.md
 * @internal
 */

import type {
  RepoCapability,
  RepoListParams,
  RepoListResult,
  RepoOpenParams,
  RepoOpenResult,
  RepoSearchParams,
  RepoSearchResult,
} from "@cogni/ai-tools";

const FAKE_SHA = "abc1234";

/**
 * Fake repo adapter for testing.
 *
 * Returns deterministic mock results without spawning subprocesses.
 */
export class FakeRepoAdapter implements RepoCapability {
  private searchCallCount = 0;
  private openCallCount = 0;
  private listCallCount = 0;

  async search(params: RepoSearchParams): Promise<RepoSearchResult> {
    this.searchCallCount++;
    const limit = Math.min(params.limit ?? 10, 3);
    const hits = Array.from({ length: limit }, (_, i) => ({
      repoId: "main",
      path: `src/mock-file-${i + 1}.ts`,
      lineStart: 1,
      lineEnd: 10,
      snippet: `// Mock search hit ${i + 1} for "${params.query}"`,
      sha: FAKE_SHA,
    }));
    return { query: params.query, hits };
  }

  async list(params: RepoListParams): Promise<RepoListResult> {
    this.listCallCount++;
    const allPaths = [
      "README.md",
      "LICENSE.md",
      "package.json",
      "src/index.ts",
      "src/utils.ts",
    ];
    const limit = Math.min(params.limit ?? 2000, 5000);
    const filtered = params.glob
      ? allPaths.filter((p) =>
          p.includes(params.glob?.replace(/\*/g, "") ?? "")
        )
      : allPaths;
    const paths = filtered.slice(0, limit);
    return { paths, sha: FAKE_SHA, truncated: filtered.length > limit };
  }

  async open(params: RepoOpenParams): Promise<RepoOpenResult> {
    this.openCallCount++;
    const lineStart = params.lineStart ?? 1;
    const lineEnd = params.lineEnd ?? lineStart + 19;
    return {
      repoId: "main",
      path: params.path.startsWith("./") ? params.path.slice(2) : params.path,
      sha: FAKE_SHA,
      lineStart,
      lineEnd,
      content: `// Mock content for ${params.path}\nexport const mock = true;\n`,
    };
  }

  async getSha(): Promise<string> {
    return FAKE_SHA;
  }

  getSearchCallCount(): number {
    return this.searchCallCount;
  }

  getOpenCallCount(): number {
    return this.openCallCount;
  }

  getListCallCount(): number {
    return this.listCallCount;
  }

  resetCallCounts(): void {
    this.searchCallCount = 0;
    this.openCallCount = 0;
    this.listCallCount = 0;
  }
}
