// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/repo/git-ls-files.adapter`
 * Purpose: Git-based repository adapter for file listing and SHA resolution.
 * Scope: Spawns `git ls-files` and `git rev-parse` (no shell). Does NOT define tool contracts.
 * Invariants:
 *   - REPO_READ_ONLY: Read-only access, no writes
 *   - SHA_STAMPED: All results include HEAD sha7
 *   - HARD_BOUNDS: max 5000 paths per request
 *   - NO_EXEC_IN_BRAIN: Only spawns `git` with fixed flags
 *   - SINGLE_RESPONSIBILITY: Owns git concerns (ls-files + rev-parse). Search/open live in RipgrepAdapter.
 * Side-effects: IO (subprocess execution)
 * Links: COGNI_BRAIN_SPEC.md
 * @internal
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { RepoListParams, RepoListResult } from "@cogni/ai-tools";

import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const execFileAsync = promisify(execFile);
const logger = makeLogger({ component: "GitLsFilesAdapter" });

// Hard bounds
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

/**
 * Configuration for GitLsFilesAdapter.
 */
export interface GitLsFilesAdapterConfig {
  /** Absolute path to repository root */
  repoRoot: string;
  /** Optional SHA override (from COGNI_REPO_SHA env) for mounts without .git */
  shaOverride?: string | undefined;
  /** Execution timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Git adapter for file listing and SHA resolution.
 *
 * Owns git concerns: `git ls-files` for path discovery,
 * `git rev-parse HEAD` for SHA resolution.
 * Separated from RipgrepAdapter to keep each adapter honest about its backend.
 */
export class GitLsFilesAdapter {
  private readonly repoRoot: string;
  private readonly shaOverride: string | undefined;
  private readonly timeoutMs: number;
  private cachedSha: string | undefined;

  constructor(config: GitLsFilesAdapterConfig) {
    this.repoRoot = resolve(config.repoRoot);
    this.shaOverride = config.shaOverride;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /**
   * Get current HEAD sha (7 chars).
   *
   * Canonical source of truth for SHA across all repo adapters.
   * Supports COGNI_REPO_SHA override for mounts without .git.
   */
  async getSha(): Promise<string> {
    if (this.cachedSha) {
      return this.cachedSha;
    }

    if (this.shaOverride) {
      this.cachedSha = this.shaOverride.slice(0, 7);
      return this.cachedSha;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.repoRoot, "rev-parse", "HEAD"],
        { timeout: this.timeoutMs }
      );
      this.cachedSha = stdout.trim().slice(0, 7);
      return this.cachedSha;
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(
          "git binary not found. Ensure git is installed and available in PATH."
        );
      }
      throw new Error(
        `Failed to resolve git SHA for repo at ${this.repoRoot}. ` +
          "Ensure .git exists or set COGNI_REPO_SHA when mounting without .git.",
        { cause }
      );
    }
  }

  /**
   * List repository files, optionally filtered by glob pattern.
   *
   * Glob is passed to `git ls-files -- <glob>` and follows git pathspec rules.
   */
  async list(params: RepoListParams): Promise<RepoListResult> {
    const sha = await this.getSha();
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // Build args: git -C <repoRoot> ls-files [-- <glob>]
    const args: string[] = ["-C", this.repoRoot, "ls-files"];
    if (params.glob) {
      args.push("--", params.glob);
    }

    let stdout: string;
    try {
      const result = await execFileAsync("git", args, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      stdout = result.stdout;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(
          "git binary not found. Ensure git is installed and available in PATH."
        );
      }
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_GIT_LS_FILES_ERROR,
          reasonCode: "list_failed",
          glob: params.glob,
        },
        "git ls-files failed"
      );
      throw error;
    }

    // Split by newlines, filter empty, canonicalize paths (strip leading ./)
    const allPaths = stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => (p.startsWith("./") ? p.slice(2) : p));

    const truncated = allPaths.length > limit;
    const paths = allPaths.slice(0, limit);

    logger.debug(
      {
        event: EVENT_NAMES.ADAPTER_GIT_LS_FILES_LIST,
        glob: params.glob,
        pathCount: paths.length,
        truncated,
      },
      "git ls-files completed"
    );

    return { paths, sha, truncated };
  }
}
