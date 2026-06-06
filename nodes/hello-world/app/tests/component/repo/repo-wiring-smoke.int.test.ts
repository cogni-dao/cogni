// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/brain/repo-wiring-smoke`
 * Purpose: End-to-end smoke test for repo capability wiring through the tool layer.
 * Scope: Validates temp git repo → createRepoCapability → tool invocation. Does not test citation guard or DI container.
 * Invariants:
 *   - SHA_STAMPED: tool results include sha7
 *   - Tool layer produces citations in correct format
 * Side-effects: IO (filesystem, rg/git subprocesses)
 * Links: src/bootstrap/capabilities/repo.ts, packages/ai-tools/src/tools/
 * @public
 */

import {
  createRepoOpenImplementation,
  createRepoSearchImplementation,
  REPO_CITATION_REGEX,
} from "@cogni/ai-tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitLsFilesAdapter, RipgrepAdapter } from "@/adapters/server";

import {
  assertBinariesAvailable,
  cleanupTempGitRepo,
  createTempGitRepo,
  KNOWN_FILE,
  type TempGitRepo,
} from "./fixtures/temp-git-repo";

let repo: TempGitRepo;
let searchTool: ReturnType<typeof createRepoSearchImplementation>;
let openTool: ReturnType<typeof createRepoOpenImplementation>;

beforeAll(() => {
  assertBinariesAvailable();
  repo = createTempGitRepo();

  // Wire capability exactly like production bootstrap does
  const gitAdapter = new GitLsFilesAdapter({ repoRoot: repo.root });
  const rgAdapter = new RipgrepAdapter({
    repoRoot: repo.root,
    repoId: "main",
    getSha: () => gitAdapter.getSha(),
  });
  const repoCapability = {
    search: (p: Parameters<typeof rgAdapter.search>[0]) => rgAdapter.search(p),
    open: (p: Parameters<typeof rgAdapter.open>[0]) => rgAdapter.open(p),
    list: (p: Parameters<typeof gitAdapter.list>[0]) => gitAdapter.list(p),
    getSha: () => gitAdapter.getSha(),
  };

  searchTool = createRepoSearchImplementation({ repoCapability });
  openTool = createRepoOpenImplementation({ repoCapability });
});

afterAll(() => {
  if (repo) cleanupTempGitRepo(repo);
});

describe("Repo wiring smoke test", () => {
  it("search and open produce valid results with sha7 and citations", async () => {
    // Search for known content
    const searchResult = await searchTool.execute({ query: "greet" });
    expect(searchResult.hits.length).toBeGreaterThan(0);

    const hit = searchResult.hits[0];
    expect(hit).toBeDefined();
    expect(hit?.sha).toBe(repo.sha7);
    expect(hit?.citation).toMatch(REPO_CITATION_REGEX);

    // Open the known file through tool layer
    const openResult = await openTool.execute({ path: KNOWN_FILE.path });
    expect(openResult.sha).toBe(repo.sha7);
    expect(openResult.content).toContain("export function greet");
    expect(openResult.citation).toMatch(REPO_CITATION_REGEX);
  });
});
