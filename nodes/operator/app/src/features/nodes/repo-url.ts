// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/repo-url`
 * Purpose: Pure parser for GitHub repo URLs accepted by the node registry.
 * Scope: Validates + extracts {owner, repo, slug}. Rejects non-github.com or non-HTTPS URLs.
 * Side-effects: none
 * @public
 */

const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

const MONOREPO_RESERVED_SLUGS = new Set([
  "operator",
  "resy",
  "node-template",
  "poly",
]);

export interface ParsedRepoUrl {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly canonicalUrl: string;
}

export function parseRepoUrl(
  input: string
): { ok: true; value: ParsedRepoUrl } | { ok: false; reason: string } {
  const trimmed = input.trim();
  const m = GITHUB_HTTPS_RE.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      reason:
        "Expected a GitHub HTTPS URL like https://github.com/<owner>/<repo>",
    };
  }
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) {
    return { ok: false, reason: "Could not extract owner/repo" };
  }
  const slug = repo.toLowerCase();
  if (MONOREPO_RESERVED_SLUGS.has(slug)) {
    return {
      ok: false,
      reason: `'${slug}' is a reserved slug for monorepo nodes — register only external repos here`,
    };
  }
  return {
    ok: true,
    value: {
      owner,
      repo,
      slug,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    },
  };
}
