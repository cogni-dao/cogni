// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/brain/repo-mount`
 * Purpose: Smoke test proving repo mount wiring works end-to-end in the stack.
 * Scope: Verifies COGNI_REPO_PATH resolves to a valid repo, adapters can open and search files. Does not test citation guard or DI container wiring.
 * Invariants:
 *   - SHA_STAMPED: results include sha7
 *   - REPO_ROOT_ONLY: adapter validates paths within repo root
 *   - HARD_BOUNDS: search results bounded per spec
 * Side-effects: IO (rg/git subprocesses, file reads)
 * Links: docs/spec/cogni-brain.md (Step 4), src/adapters/server/repo/
 * @public
 */

import { beforeAll, describe, expect, it } from "vitest";

import { GitLsFilesAdapter, RipgrepAdapter } from "@/adapters/server";

const REPO_PATH = process.env.COGNI_REPO_PATH;

describe("Brain repo mount smoke test", () => {
  let gitAdapter: GitLsFilesAdapter;
  let adapter: RipgrepAdapter;

  beforeAll(() => {
    if (!REPO_PATH) throw new Error("COGNI_REPO_PATH is not set");
    gitAdapter = new GitLsFilesAdapter({
      repoRoot: REPO_PATH,
    });
    adapter = new RipgrepAdapter({
      repoRoot: REPO_PATH,
      repoId: "main",
      getSha: () => gitAdapter.getSha(),
      timeoutMs: 2_000,
    });
  });

  it("COGNI_REPO_PATH is set and non-empty", () => {
    expect(REPO_PATH).toBeDefined();
    expect(REPO_PATH).not.toBe("");
  });

  it("GitLsFilesAdapter.getSha() returns a 7-char hex sha", async () => {
    const sha = await gitAdapter.getSha();
    expect(sha).toMatch(/^[0-9a-f]{7}$/);
  });

  it("repo.open(package.json) returns content with sha", async () => {
    const result = await adapter.open({ path: "package.json" });

    expect(result.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(result.path).toBe("package.json");
    expect(result.content).toContain("cogni-template");
    expect(result.lineStart).toBeGreaterThanOrEqual(1);
    expect(result.lineEnd).toBeGreaterThanOrEqual(result.lineStart);
  });

  it("repo.open(ROADMAP.md) is readable", async () => {
    const result = await adapter.open({ path: "ROADMAP.md" });

    expect(result.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("repo.search returns bounded results with sha7", async () => {
    // Single-file glob keeps rg deterministic and sub-second
    const result = await adapter.search({
      query: "LicenseRef-PolyForm-Shield",
      glob: "Dockerfile",
      limit: 1,
    });

    expect(result.hits.length).toBe(1);

    const hit = result.hits[0];
    if (!hit) throw new Error("Expected at least one search hit");
    expect(hit.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(hit.path).toContain("Dockerfile");
    expect(hit.lineStart).toBeGreaterThanOrEqual(1);
    expect(hit.snippet).toContain("LicenseRef-PolyForm-Shield");
  });
});
