// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/repo/fixtures/temp-git-repo`
 * Purpose: Reusable temp git repo fixture for repo adapter and brain component tests.
 * Scope: Creates disposable git repos with known content. Does not contain test assertions.
 * Invariants:
 *   - Cleanup always runs, even on test failure
 *   - Git identity set for CI compatibility (no global git config required)
 *   - Preflight checks for rg and git binaries
 * Side-effects: IO (filesystem, git subprocess)
 * Links: tests/component/repo/, tests/component/brain/
 * @internal
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Git env vars for CI — no global git config required */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.local",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.local",
};

/**
 * Known test file written into every temp repo.
 * Tests can assert against this content.
 */
export const KNOWN_FILE = {
  path: "src/example.ts",
  content: [
    "// Example file for testing",
    "export function greet(name: string): string {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal in test fixture string
    "  return `Hello, ${name}!`;",
    "}",
    "",
    'export const VERSION = "1.0.0";',
    "",
    "// End of file",
    "",
  ].join("\n"),
};

export interface TempGitRepo {
  /** Absolute path to the temp repo root */
  readonly root: string;
  /** The 7-char SHA of the initial commit */
  readonly sha7: string;
}

/**
 * Check that rg and git binaries are available.
 * Throws with a clear message if either is missing.
 */
export function assertBinariesAvailable(): void {
  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "git binary not found. Install git to run repo component tests."
    );
  }
  try {
    execSync("rg --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "rg (ripgrep) binary not found. Install ripgrep to run repo component tests."
    );
  }
}

/**
 * Create a temp git repo with a known file and initial commit.
 *
 * @returns TempGitRepo with root path and sha7
 */
export function createTempGitRepo(): TempGitRepo {
  // Resolve symlinks (macOS: /tmp → /private/tmp) so validatePath's realpath check passes
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repo-test-"))
  );

  const git = (cmd: string) =>
    execSync(cmd, {
      cwd: root,
      env: { ...process.env, ...GIT_ENV },
      stdio: "pipe",
    });

  // Init repo and write known file
  git("git init");
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(root, KNOWN_FILE.path), KNOWN_FILE.content);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-repo", version: "0.0.0" })
  );

  // Commit
  git("git add -A");
  git('git commit -m "initial commit"');

  // Get sha
  const sha = git("git rev-parse HEAD").toString().trim().slice(0, 7);

  return { root, sha7: sha };
}

/**
 * Remove a temp git repo directory.
 * Safe to call multiple times.
 */
export function cleanupTempGitRepo(repo: TempGitRepo): void {
  fs.rmSync(repo.root, { recursive: true, force: true });
}
