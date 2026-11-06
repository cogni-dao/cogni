// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-declaration-reader.adapter`
 * Purpose: Read a node's declarations (`.cogni/repo-spec.yaml`, `.cogni/workloads/*`) at a sha from a
 *   PUBLIC GitHub repository without any credential, and compose that read behind the operator App read
 *   so ONE deploy call works in every env (story.5137): the App when it is installed on the repo, the
 *   anonymous read when it is not (the candidate's test App has no access to canonical node repos).
 * Scope: Read-only. No secret, no write, no new env. File text comes from `raw.githubusercontent.com`
 *   (a CDN that does not spend the 60 requests/hour anonymous REST budget); only the directory listing
 *   uses the REST contents API (one request per deploy).
 * Invariants:
 *   - APP_FIRST: the App is tried first. Only an App "not installed on this repo" error (code
 *     `github_app_not_installed`, HTTP 404 from the installation lookup) falls back to the anonymous
 *     read. Any other App failure (bad credential, 5xx, rate limit) is thrown, never masked.
 *   - NOT_PUBLIC_IS_ABSENT: a repo the App cannot read and that is not public returns `null`.
 *   - SAME_CHECKS_AS_APP: the directory listing maps a submodule entry exactly like the App read
 *     (`git_url` into `/git/trees/`), so the caller's entry and size checks are unchanged. A response
 *     over `MAX_FILE_BYTES` throws.
 *   - BOUNDED: every request has a timeout; a transport error or a 5xx throws.
 * Side-effects: IO (HTTPS to raw.githubusercontent.com and api.github.com, anonymous)
 * Links: ports/deploy-plane.port.ts (`DeclarationReadPort`), adapters/server/vcs/github-repo-write.ts,
 *   features/node-deploy/read-declarations.ts
 * @internal
 */

import type { DeclarationReadPort } from "@/ports";
import { GITHUB_APP_NOT_INSTALLED } from "./github-repo-write";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
/** A repo-spec or manifest is a few KiB; anything past this is not a declaration. */
export const MAX_FILE_BYTES = 1_048_576;

type DirectoryEntry = { name: string; type: string; size: number };

export class GitHubPublicReader implements DeclarationReadPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  private check(input: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): void {
    if (
      !NAME_RE.test(input.owner) ||
      !NAME_RE.test(input.repo) ||
      (input.ref !== undefined && !REF_RE.test(input.ref)) ||
      input.path.split("/").some((seg) => seg === ".." || seg === "")
    )
      throw new Error("invalid public read target");
  }

  async fetchFileText(input: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    this.check(input);
    const path = input.path.split("/").map(encodeURIComponent).join("/");
    const ref = (input.ref ?? "main").split("/").map(encodeURIComponent);
    const response = await this.fetchImpl(
      `https://raw.githubusercontent.com/${input.owner}/${input.repo}/${ref.join("/")}/${path}`,
      { signal: AbortSignal.timeout(this.timeoutMs) }
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`public file read failed (HTTP ${response.status})`);
    const text = await response.text();
    if (text.length > MAX_FILE_BYTES)
      throw new Error("public file read over the size cap");
    return text;
  }

  async listDirectoryEntries(input: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<readonly DirectoryEntry[] | null> {
    this.check(input);
    const path = input.path.split("/").map(encodeURIComponent).join("/");
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${input.owner}/${input.repo}/contents/${path}?ref=${encodeURIComponent(input.ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cogni-operator",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`public directory read failed (HTTP ${response.status})`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return null;
    return (
      data as Array<{
        name: string;
        type: string;
        size: number;
        git_url?: string | null;
      }>
    ).map((entry) => ({
      name: entry.name,
      // Same mapping as the App read: GitHub lists a submodule as "file" with a git_url into /git/trees/.
      type: entry.git_url?.includes("/git/trees/") ? "submodule" : entry.type,
      size: entry.size,
    }));
  }
}

/** The operator App read first; the anonymous public read only where the App is not installed. */
export class AppOrPublicDeclarationReader implements DeclarationReadPort {
  /** Repos this instance already learned the App is not installed on (one request, one lookup). */
  private readonly notInstalled = new Set<string>();

  constructor(
    private readonly app: DeclarationReadPort,
    private readonly publicReader: DeclarationReadPort
  ) {}

  private async read<T>(
    owner: string,
    repo: string,
    viaApp: (reader: DeclarationReadPort) => Promise<T>
  ): Promise<T> {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!this.notInstalled.has(key)) {
      try {
        return await viaApp(this.app);
      } catch (error) {
        if ((error as { code?: unknown })?.code !== GITHUB_APP_NOT_INSTALLED)
          throw error;
        this.notInstalled.add(key);
      }
    }
    return viaApp(this.publicReader);
  }

  fetchFileText(input: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    return this.read(input.owner, input.repo, (r) => r.fetchFileText(input));
  }

  listDirectoryEntries(input: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<readonly DirectoryEntry[] | null> {
    return this.read(input.owner, input.repo, (r) =>
      r.listDirectoryEntries(input)
    );
  }
}
