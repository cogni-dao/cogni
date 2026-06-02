// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/repo/ripgrep-adapter`
 * Purpose: Integration tests for RipgrepAdapter against a real temp git repo.
 * Scope: Tests path validation, search bounds, SHA stamping, and security invariants. Does not test DI wiring.
 * Invariants:
 *   - REPO_ROOT_ONLY: rejects .., absolute paths, symlink escapes
 *   - SHA_STAMPED: all results include sha7
 *   - HARD_BOUNDS: open capped at 200 lines, search bounded, files ≤256KB
 * Side-effects: IO (filesystem, rg/git subprocesses)
 * Links: src/adapters/server/repo/ripgrep.adapter.ts, COGNI_BRAIN_SPEC.md
 * @public
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GitLsFilesAdapter,
  RepoPathError,
  RipgrepAdapter,
} from "@/adapters/server/repo";

import {
  assertBinariesAvailable,
  cleanupTempGitRepo,
  createTempGitRepo,
  KNOWN_FILE,
  type TempGitRepo,
} from "./fixtures/temp-git-repo";

let repo: TempGitRepo;
let gitAdapter: GitLsFilesAdapter;
let adapter: RipgrepAdapter;

beforeAll(() => {
  assertBinariesAvailable();
  repo = createTempGitRepo();
  gitAdapter = new GitLsFilesAdapter({ repoRoot: repo.root });
  adapter = new RipgrepAdapter({
    repoRoot: repo.root,
    repoId: "main",
    getSha: () => gitAdapter.getSha(),
  });
});

afterAll(() => {
  if (repo) cleanupTempGitRepo(repo);
});

describe("RipgrepAdapter", () => {
  describe("getSha", () => {
    it("returns a 7-char hex string matching the repo HEAD", async () => {
      const sha = await adapter.getSha();
      expect(sha).toMatch(/^[0-9a-f]{7}$/);
      expect(sha).toBe(repo.sha7);
    });
  });

  describe("open", () => {
    it("returns correct content for a known file", async () => {
      const result = await adapter.open({ path: KNOWN_FILE.path });
      expect(result.sha).toBe(repo.sha7);
      expect(result.repoId).toBe("main");
      expect(result.path).toBe(KNOWN_FILE.path);
      expect(result.content).toContain("export function greet");
      expect(result.lineStart).toBe(1);
    });

    it("clamps output to MAX_OPEN_LINES (200)", async () => {
      // Write a file with >200 lines
      const bigFile = "big.ts";
      const lines = Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`);
      fs.writeFileSync(path.join(repo.root, bigFile), lines.join("\n"));

      const result = await adapter.open({ path: bigFile });
      const resultLines = result.content.split("\n");
      expect(resultLines.length).toBeLessThanOrEqual(200);
      expect(result.lineEnd).toBeLessThanOrEqual(200);
    });

    it("rejects absolute paths", async () => {
      await expect(adapter.open({ path: "/etc/passwd" })).rejects.toThrow(
        RepoPathError
      );

      try {
        await adapter.open({ path: "/etc/passwd" });
      } catch (e) {
        expect((e as RepoPathError).code).toBe("TRAVERSAL");
      }
    });

    it("rejects .. traversal", async () => {
      await expect(
        adapter.open({ path: "../../../etc/passwd" })
      ).rejects.toThrow(RepoPathError);

      try {
        await adapter.open({ path: "../../../etc/passwd" });
      } catch (e) {
        expect((e as RepoPathError).code).toBe("TRAVERSAL");
      }
    });

    it("rejects symlink that escapes repo root", async () => {
      // Create a symlink inside the repo pointing outside
      const linkPath = path.join(repo.root, "escape-link.ts");
      fs.symlinkSync("/etc/hosts", linkPath);

      await expect(adapter.open({ path: "escape-link.ts" })).rejects.toThrow(
        RepoPathError
      );

      try {
        await adapter.open({ path: "escape-link.ts" });
      } catch (e) {
        expect((e as RepoPathError).code).toBe("SYMLINK_ESCAPE");
      }
    });

    it("rejects files exceeding 256KB", async () => {
      const bigFile = "huge.txt";
      // Write a file just over 256KB
      fs.writeFileSync(
        path.join(repo.root, bigFile),
        Buffer.alloc(256 * 1024 + 1, "x")
      );

      await expect(adapter.open({ path: bigFile })).rejects.toThrow(
        RepoPathError
      );

      try {
        await adapter.open({ path: bigFile });
      } catch (e) {
        expect((e as RepoPathError).code).toBe("TOO_LARGE");
      }
    });
  });

  describe("search", () => {
    it("returns bounded results with sha7; no-match returns empty", async () => {
      // Match should find the known file
      const result = await adapter.search({ query: "greet", limit: 5 });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.length).toBeLessThanOrEqual(5);
      for (const hit of result.hits) {
        expect(hit.sha).toBe(repo.sha7);
        expect(hit.repoId).toBe("main");
      }

      // No-match returns empty
      const noMatch = await adapter.search({ query: "zzz_nonexistent_zzz" });
      expect(noMatch.hits).toEqual([]);
    });
  });
});
