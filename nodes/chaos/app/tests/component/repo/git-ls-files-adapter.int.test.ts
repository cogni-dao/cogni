// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/repo/git-ls-files-adapter`
 * Purpose: Integration tests for GitLsFilesAdapter and cross-tool path invariants.
 * Scope: Tests list(), getSha(), path canonicalization, and list-to-open round-trip. Does not test DI wiring.
 * Invariants:
 *   - SHA_STAMPED: all results include sha7
 *   - PATH_CANONICAL: no leading "./" in any tool output
 *   - HARD_BOUNDS: list capped at limit, truncated flag honest
 * Side-effects: IO (filesystem, git/rg subprocesses)
 * Links: src/adapters/server/repo/git-ls-files.adapter.ts, COGNI_BRAIN_SPEC.md
 * @public
 */

import { makeRepoCitation, REPO_CITATION_REGEX } from "@cogni/ai-tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitLsFilesAdapter, RipgrepAdapter } from "@/adapters/server/repo";

import {
  assertBinariesAvailable,
  cleanupTempGitRepo,
  createTempGitRepo,
  KNOWN_FILE,
  type TempGitRepo,
} from "./fixtures/temp-git-repo";

let repo: TempGitRepo;
let gitAdapter: GitLsFilesAdapter;
let rgAdapter: RipgrepAdapter;

beforeAll(() => {
  assertBinariesAvailable();
  repo = createTempGitRepo();
  gitAdapter = new GitLsFilesAdapter({ repoRoot: repo.root });
  rgAdapter = new RipgrepAdapter({
    repoRoot: repo.root,
    repoId: "main",
    getSha: () => gitAdapter.getSha(),
  });
});

afterAll(() => {
  if (repo) cleanupTempGitRepo(repo);
});

describe("GitLsFilesAdapter", () => {
  describe("getSha", () => {
    it("returns a 7-char hex string matching the repo HEAD", async () => {
      const sha = await gitAdapter.getSha();
      expect(sha).toMatch(/^[0-9a-f]{7}$/);
      expect(sha).toBe(repo.sha7);
    });
  });

  describe("list", () => {
    it("returns all tracked files with sha and no leading ./", async () => {
      const result = await gitAdapter.list({});
      expect(result.sha).toBe(repo.sha7);
      expect(result.truncated).toBe(false);
      expect(result.paths.length).toBeGreaterThan(0);

      for (const p of result.paths) {
        expect(p).not.toMatch(/^\.\//);
      }
    });

    it("includes the known file", async () => {
      const result = await gitAdapter.list({});
      expect(result.paths).toContain(KNOWN_FILE.path);
    });

    it("filters by glob (git pathspec)", async () => {
      const result = await gitAdapter.list({ glob: "*.json" });
      expect(result.paths.length).toBeGreaterThan(0);
      for (const p of result.paths) {
        expect(p).toMatch(/\.json$/);
      }
    });

    it("respects limit and sets truncated flag", async () => {
      const result = await gitAdapter.list({ limit: 1 });
      expect(result.paths.length).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it("returns empty for non-matching glob", async () => {
      const result = await gitAdapter.list({ glob: "*.nonexistent_ext_zzz" });
      expect(result.paths).toEqual([]);
      expect(result.truncated).toBe(false);
    });
  });
});

describe("Cross-tool path invariants", () => {
  it("list path works in open and produces valid citation", async () => {
    const listResult = await gitAdapter.list({ glob: "src/*.ts" });
    expect(listResult.paths).toContain(KNOWN_FILE.path);

    const openResult = await rgAdapter.open({ path: KNOWN_FILE.path });
    expect(openResult.path).toBe(KNOWN_FILE.path);
    expect(openResult.sha).toBe(repo.sha7);

    const citation = makeRepoCitation(openResult);
    expect(citation).toMatch(REPO_CITATION_REGEX);
  });

  it("search path works in open and produces valid citation", async () => {
    const searchResult = await rgAdapter.search({ query: "greet", limit: 1 });
    expect(searchResult.hits.length).toBe(1);

    const hit = searchResult.hits[0];
    if (!hit) throw new Error("Expected at least one search hit");
    expect(hit.path).not.toMatch(/^\.\//);

    const openResult = await rgAdapter.open({ path: hit.path });
    expect(openResult.path).toBe(hit.path);

    const searchCitation = makeRepoCitation(hit);
    const openCitation = makeRepoCitation(openResult);
    expect(searchCitation).toMatch(REPO_CITATION_REGEX);
    expect(openCitation).toMatch(REPO_CITATION_REGEX);
  });

  it("list and search return same canonical path for same file", async () => {
    const listResult = await gitAdapter.list({ glob: "src/*.ts" });
    const searchResult = await rgAdapter.search({ query: "greet", limit: 1 });

    const listPath = listResult.paths.find((p) => p.includes("example"));
    const searchPath = searchResult.hits[0]?.path;

    expect(listPath).toBeDefined();
    expect(searchPath).toBeDefined();
    expect(listPath).toBe(searchPath);
  });
});
