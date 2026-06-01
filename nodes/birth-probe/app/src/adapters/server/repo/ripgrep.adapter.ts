// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/repo/ripgrep.adapter`
 * Purpose: Ripgrep-based code search and file open adapter.
 * Scope: Spawns `rg --json` (no shell) for search, reads files for open. Does NOT define tool contracts.
 * Invariants:
 *   - REPO_READ_ONLY: Read-only access, no writes
 *   - REPO_ROOT_ONLY: All paths validated to be within repo root (rejects .., symlinks)
 *   - SHA_STAMPED: All results include HEAD sha7 (injected via getSha callback)
 *   - HARD_BOUNDS: search≤50 hits, snippet≤20 lines, open≤200 lines, max 256KB
 *   - NO_EXEC_IN_BRAIN: Only spawns `rg` with fixed flags
 *   - RG_BINARY_NOT_NPM: Uses system `rg` binary
 *   - PATH_CANONICAL: All output paths use canonical format (no leading ./)
 * Side-effects: IO (subprocess execution, file reads)
 * Links: COGNI_BRAIN_SPEC.md
 * @internal
 */

import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  RepoOpenParams,
  RepoOpenResult,
  RepoSearchHit,
  RepoSearchParams,
  RepoSearchResult,
} from "@cogni/ai-tools";

import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const execFileAsync = promisify(execFile);
const logger = makeLogger({ component: "RipgrepAdapter" });

// Hard bounds per COGNI_BRAIN_SPEC
const MAX_SEARCH_HITS = 50;
const MAX_SNIPPET_LINES = 20;
const MAX_OPEN_LINES = 200;
const MAX_FILE_SIZE_BYTES = 256 * 1024; // 256KB

// Default ignores per COGNI_BRAIN_SPEC
const DEFAULT_IGNORES = [
  "node_modules",
  "dist",
  ".next",
  ".git",
  "vendor",
  "*.min.js",
  "*.min.css",
  "package-lock.json",
  "pnpm-lock.yaml",
];

/**
 * Ripgrep JSON output line types.
 */
interface RgMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number; end: number }>;
  };
}

interface RgEnd {
  type: "end";
  data: { stats: { matched_lines: number } };
}

type RgLine = RgMatch | RgEnd | { type: string };

/**
 * Strip leading "./" from a path to produce canonical format.
 */
function canonicalizePath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

/**
 * Configuration for RipgrepAdapter.
 */
export interface RipgrepAdapterConfig {
  /** Absolute path to repository root */
  repoRoot: string;
  /** Repository identifier (e.g., "main") */
  repoId: string;
  /** Callback to get HEAD sha7 (owned by GitLsFilesAdapter) */
  getSha: () => Promise<string>;
  /** Execution timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Path validation error.
 */
export class RepoPathError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "TRAVERSAL"
      | "SYMLINK_ESCAPE"
      | "NOT_FILE"
      | "NOT_FOUND"
      | "TOO_LARGE"
  ) {
    super(message);
    this.name = "RepoPathError";
  }
}

/**
 * Ripgrep adapter for code search and file open.
 *
 * Per RG_BINARY_NOT_NPM: Uses system `rg` binary via child_process.
 * Per REPO_ROOT_ONLY: All paths validated before access.
 *
 * Does not implement RepoCapability directly — the bootstrap factory
 * composes this with GitLsFilesAdapter to form the full capability.
 */
export class RipgrepAdapter {
  private readonly repoRoot: string;
  private readonly repoId: string;
  private readonly timeoutMs: number;
  readonly getSha: () => Promise<string>;

  constructor(config: RipgrepAdapterConfig) {
    this.repoRoot = resolve(config.repoRoot);
    this.repoId = config.repoId;
    this.getSha = config.getSha;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /**
   * Validate that a path is safe to access.
   * Rejects paths with .. segments and symlinks that escape repo root.
   */
  private async validatePath(relativePath: string): Promise<string> {
    // Reject absolute paths
    if (relativePath.startsWith("/")) {
      throw new RepoPathError(
        `Absolute paths not allowed: ${relativePath}`,
        "TRAVERSAL"
      );
    }

    // Reject .. segments
    const normalized = normalize(relativePath);
    if (normalized.startsWith("..") || normalized.includes("/..")) {
      throw new RepoPathError(
        `Path traversal not allowed: ${relativePath}`,
        "TRAVERSAL"
      );
    }

    const fullPath = join(this.repoRoot, normalized);

    // Resolve symlinks and check if still within repo root
    let realPath: string;
    try {
      realPath = await realpath(fullPath);
    } catch {
      throw new RepoPathError(`File not found: ${relativePath}`, "NOT_FOUND");
    }

    const relativeToRoot = relative(this.repoRoot, realPath);
    if (relativeToRoot.startsWith("..")) {
      throw new RepoPathError(
        `Symlink escapes repo root: ${relativePath}`,
        "SYMLINK_ESCAPE"
      );
    }

    // Check it's a regular file
    const stats = await stat(realPath);
    if (!stats.isFile()) {
      throw new RepoPathError(
        `Not a regular file: ${relativePath}`,
        "NOT_FILE"
      );
    }

    // Check file size
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      throw new RepoPathError(
        `File exceeds ${MAX_FILE_SIZE_BYTES} bytes: ${relativePath}`,
        "TOO_LARGE"
      );
    }

    return realPath;
  }

  /**
   * Search repository using ripgrep.
   */
  async search(params: RepoSearchParams): Promise<RepoSearchResult> {
    const sha = await this.getSha();
    const limit = Math.min(params.limit ?? 10, MAX_SEARCH_HITS);

    // Build ripgrep args array — NO shell, per NO_SHELL_EXEC invariant
    const args: string[] = [
      "--json",
      `--max-count=${limit}`,
      "-C",
      String(Math.floor(MAX_SNIPPET_LINES / 2)),
    ];
    for (const pattern of DEFAULT_IGNORES) {
      args.push("-g", `!${pattern}`);
    }
    if (params.glob) {
      args.push("-g", params.glob);
    }
    // Explicit '.' prevents rg from blocking on stdin when spawned via execFile
    // (no TTY → rg defaults to reading stdin instead of walking cwd)
    args.push("--", params.query, ".");

    let stdout: string;
    try {
      const result = await execFileAsync("rg", args, {
        cwd: this.repoRoot,
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      stdout = result.stdout;
    } catch (error) {
      // rg returns exit code 1 when no matches found.
      // execFile sets error.code to the numeric exit code.
      if (
        error instanceof Error &&
        "code" in error &&
        (error as unknown as { code: number }).code === 1
      ) {
        return { query: params.query, hits: [] };
      }
      // Check if it's an exec error with stdout (partial results)
      if (error instanceof Error && "stdout" in error) {
        stdout = (error as { stdout: string }).stdout || "";
        if (!stdout) {
          logger.error(
            {
              event: EVENT_NAMES.ADAPTER_RIPGREP_ERROR,
              reasonCode: "search_failed",
              query: params.query,
            },
            "Ripgrep search failed"
          );
          return { query: params.query, hits: [] };
        }
      } else {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_RIPGREP_ERROR,
            reasonCode: "search_failed",
            query: params.query,
          },
          "Ripgrep search failed"
        );
        return { query: params.query, hits: [] };
      }
    }

    // Parse JSON lines output
    const hits: RepoSearchHit[] = [];
    const lines = stdout.trim().split("\n").filter(Boolean);

    // Group matches by file for context aggregation
    const matchesByFile = new Map<
      string,
      { lineNumbers: number[]; snippetLines: string[] }
    >();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RgLine;
        if (parsed.type === "match") {
          const match = parsed as RgMatch;
          // Canonicalize path: rg with "." root may emit "./src/foo.ts"
          const path = canonicalizePath(match.data.path.text);
          const lineNum = match.data.line_number;
          const lineText = match.data.lines.text;

          let fileData = matchesByFile.get(path);
          if (!fileData) {
            fileData = { lineNumbers: [], snippetLines: [] };
            matchesByFile.set(path, fileData);
          }
          fileData.lineNumbers.push(lineNum);
          fileData.snippetLines.push(lineText);
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    // Convert to hits
    for (const [path, data] of matchesByFile) {
      if (hits.length >= limit) break;

      const lineStart = Math.min(...data.lineNumbers);
      const lineEnd = Math.min(
        Math.max(...data.lineNumbers),
        lineStart + MAX_SNIPPET_LINES - 1
      );
      const snippet = data.snippetLines.slice(0, MAX_SNIPPET_LINES).join("");

      hits.push({
        repoId: this.repoId,
        path,
        lineStart,
        lineEnd,
        snippet: snippet.slice(0, 2000), // Cap snippet length
        sha,
      });
    }

    logger.debug(
      {
        event: EVENT_NAMES.ADAPTER_RIPGREP_SEARCH,
        query: params.query,
        hitCount: hits.length,
      },
      "Ripgrep search completed"
    );

    return { query: params.query, hits };
  }

  /**
   * Open a file and retrieve content.
   */
  async open(params: RepoOpenParams): Promise<RepoOpenResult> {
    let sha: string;
    let realPath: string;
    try {
      sha = await this.getSha();
      realPath = await this.validatePath(params.path);
    } catch (error) {
      const reasonCode =
        error instanceof RepoPathError ? error.code : "open_failed";
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_RIPGREP_ERROR,
          reasonCode,
          path: params.path,
        },
        "Ripgrep open failed"
      );
      throw error;
    }

    // Read file
    const content = await readFile(realPath, "utf-8");
    const lines = content.split("\n");

    // Calculate line range
    const lineStart = Math.max(1, params.lineStart ?? 1);
    const lineEnd = Math.min(
      lines.length,
      params.lineEnd ?? lineStart + MAX_OPEN_LINES - 1,
      lineStart + MAX_OPEN_LINES - 1
    );

    // Extract requested lines (convert to 0-indexed)
    const selectedLines = lines.slice(lineStart - 1, lineEnd);
    const resultContent = selectedLines.join("\n");

    logger.debug(
      {
        event: EVENT_NAMES.ADAPTER_RIPGREP_OPEN,
        path: params.path,
        lineStart,
        lineEnd,
      },
      "File opened"
    );

    return {
      repoId: this.repoId,
      path: canonicalizePath(params.path),
      sha,
      lineStart,
      lineEnd,
      content: resultContent,
    };
  }
}
