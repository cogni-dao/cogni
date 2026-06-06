// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/brain/repo-sha-override`
 * Purpose: Regression gate proving COGNI_REPO_SHA override is wired through createRepoCapability.
 * Scope: Validates the production path where git-sync worktree has no usable .git. Does NOT cover
 *        git-sync clone lifecycle, network failures, or missing rg binary.
 * Invariants:
 *   - SHA_SOURCE_OF_TRUTH: when COGNI_REPO_SHA is set, getSha() returns it (not git)
 *   - WIRING_GATE: createRepoCapability passes env.COGNI_REPO_SHA → GitLsFilesAdapter.shaOverride
 * Side-effects: IO (rg subprocess for search/open, file reads)
 * Links: src/bootstrap/capabilities/repo.ts, src/adapters/server/repo/git-ls-files.adapter.ts
 * @public
 */

import { beforeAll, describe, expect, it } from "vitest";

import { GitLsFilesAdapter, RipgrepAdapter } from "@/adapters/server";
import { createRepoCapability } from "@/bootstrap/capabilities/repo";
import type { ServerEnv } from "@/shared/env";

// Synthetic SHA that will never match a real git rev-parse output.
// If getSha() returns this, the override is wired. If it returns something else, it fell through to git.
const SYNTHETIC_SHA = "deadbeef01234567890abcdef";
const SYNTHETIC_SHA7 = SYNTHETIC_SHA.slice(0, 7);

const REPO_PATH = process.env.COGNI_REPO_PATH ?? "";

describe("Brain repo SHA override (production path)", () => {
  beforeAll(() => {
    if (!REPO_PATH) throw new Error("COGNI_REPO_PATH is not set");
  });

  describe("adapter-level: GitLsFilesAdapter.shaOverride", () => {
    it("getSha() returns the override, not git rev-parse", async () => {
      const adapter = new GitLsFilesAdapter({
        repoRoot: REPO_PATH,
        shaOverride: SYNTHETIC_SHA,
      });

      const sha = await adapter.getSha();
      expect(sha).toBe(SYNTHETIC_SHA7);
    });

    it("search results carry the overridden SHA", async () => {
      const gitAdapter = new GitLsFilesAdapter({
        repoRoot: REPO_PATH,
        shaOverride: SYNTHETIC_SHA,
      });
      const rgAdapter = new RipgrepAdapter({
        repoRoot: REPO_PATH,
        repoId: "main",
        getSha: () => gitAdapter.getSha(),
        timeoutMs: 5_000,
      });

      const result = await rgAdapter.search({
        query: "LicenseRef-PolyForm-Shield",
        glob: "Dockerfile",
        limit: 1,
      });

      expect(result.hits.length).toBe(1);
      expect(result.hits[0]?.sha).toBe(SYNTHETIC_SHA7);
    });

    it("open results carry the overridden SHA", async () => {
      const gitAdapter = new GitLsFilesAdapter({
        repoRoot: REPO_PATH,
        shaOverride: SYNTHETIC_SHA,
      });
      const rgAdapter = new RipgrepAdapter({
        repoRoot: REPO_PATH,
        repoId: "main",
        getSha: () => gitAdapter.getSha(),
        timeoutMs: 5_000,
      });

      const result = await rgAdapter.open({ path: "ROADMAP.md" });
      expect(result.sha).toBe(SYNTHETIC_SHA7);
      expect(result.content.length).toBeGreaterThan(0);
    });
  });

  describe("wiring-level: createRepoCapability passes COGNI_REPO_SHA", () => {
    it("capability.getSha() returns the env override, not git", async () => {
      // Minimal ServerEnv mock — only fields consumed by createRepoCapability
      const fakeEnv = {
        isTestMode: false,
        COGNI_REPO_ROOT: REPO_PATH,
        COGNI_REPO_SHA: SYNTHETIC_SHA,
      } as ServerEnv;

      const capability = createRepoCapability(fakeEnv);
      const sha = await capability.getSha();

      // If this fails with a real 7-char hex SHA, the shaOverride wiring is broken —
      // createRepoCapability isn't passing env.COGNI_REPO_SHA to GitLsFilesAdapter.
      expect(sha).toBe(SYNTHETIC_SHA7);
    });

    it("capability.search() returns citations with the overridden SHA", async () => {
      const fakeEnv = {
        isTestMode: false,
        COGNI_REPO_ROOT: REPO_PATH,
        COGNI_REPO_SHA: SYNTHETIC_SHA,
      } as ServerEnv;

      const capability = createRepoCapability(fakeEnv);
      const result = await capability.search({
        query: "LicenseRef-PolyForm-Shield",
        glob: "Dockerfile",
        limit: 1,
      });

      expect(result.hits.length).toBe(1);
      expect(result.hits[0]?.sha).toBe(SYNTHETIC_SHA7);
    });
  });
});
