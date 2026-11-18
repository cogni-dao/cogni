// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-pr-facts`
 * Purpose: The work-items `PrFactsPort` (task.0122): a PR's current head and merge state for the code gates of a work item.
 * Scope: Adapts the operator's GitHub App read (`GitHubVcsAdapter.getPrFacts`) to the port, and falls back to the public GitHub read
 *   when the App is unconfigured or not installed on that repository (the operator works across repositories). The 5 s timeout and
 *   the 60 s cache per PR URL belong to the work-items adapter, not to this wiring.
 * Invariants:
 *   - NO_NEW_SECRETS: the App credentials already configured for the VCS capability, or no credential at all.
 *   - FAILURE_THROWS: any non-2xx, an unparseable URL or an unreadable head throws; the gate answers 503 and writes nothing.
 * Side-effects: IO (one GitHub REST read per call)
 * Links: hub work-cicd-gates-design (One gate predicate), ./vcs.ts
 * @internal
 */

import {
  type PrFactsPort,
  parsePullRequestUrl,
  resolvePrRepoPin,
} from "@cogni/work-items";

/** `WORK_ITEMS_PR_REPO` as the gate takes it; the one reader lives with the gate predicate in `@cogni/work-items`. */
export const resolveWorkItemsPrRepos = resolvePrRepoPin;

/** The App-authenticated read: structurally `GitHubVcsAdapter.getPrFacts`. */
export interface AppPrFactsReader {
  getPrFacts(params: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
  }): Promise<{ headSha: string; merged: boolean }>;
}

/** The App-authenticated reader of a VCS capability, when it has one (the unconfigured stub does not). */
export function appPrFactsReader(vcs: object): AppPrFactsReader | undefined {
  const read = (vcs as { getPrFacts?: unknown }).getPrFacts;
  return typeof read === "function" ? (vcs as AppPrFactsReader) : undefined;
}

const GITHUB_API = "https://api.github.com";

export function createPrFactsPort(deps: {
  readonly app?: AppPrFactsReader | undefined;
  readonly fetchFn?: typeof fetch;
}): PrFactsPort {
  const fetchFn = deps.fetchFn ?? fetch;

  async function publicRead(
    owner: string,
    repo: string,
    prNumber: number,
    signal: AbortSignal
  ): Promise<{ headSha: string; merged: boolean }> {
    const res = await fetchFn(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cogni-node",
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub PR read failed (HTTP ${res.status})`);
    const pr = (await res.json()) as {
      head?: { sha?: unknown };
      merged?: unknown;
    };
    return {
      headSha: typeof pr.head?.sha === "string" ? pr.head.sha : "",
      merged: pr.merged === true,
    };
  }

  return {
    async read(url, signal) {
      const parsed = parsePullRequestUrl(url);
      if (!parsed) throw new Error("not a GitHub pull request URL");
      const { owner, repo, number } = parsed;
      let facts: { headSha: string; merged: boolean };
      try {
        if (!deps.app) throw new Error("github app unavailable");
        facts = await deps.app.getPrFacts({
          owner,
          repo,
          prNumber: number,
          signal,
        });
      } catch {
        // App unconfigured, not installed on this repository, or the read failed: the public read answers or throws.
        facts = await publicRead(owner, repo, number, signal);
      }
      const head = facts.headSha.toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("unreadable PR head");
      return { head, merged: facts.merged };
    },
  };
}
