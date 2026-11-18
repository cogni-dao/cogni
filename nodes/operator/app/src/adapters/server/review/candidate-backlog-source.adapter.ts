// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/review/candidate-backlog-source.adapter`
 * Purpose: The candidate backlog KPI source (task.5498): one bounded read of a node repo's open non-draft pull
 *   requests and one check-suites read per head SHA, through the operator's EXISTING GitHub App (the review App,
 *   `GH_REVIEW_APP_ID`); no new credential.
 * Scope: IO only. Classification and the calculators live in `features/node-deploy/candidate-backlog-kpis.ts`.
 * Invariants:
 *   - READ_ONLY: GETs through the App installation on the repo. An App not installed on the repo is an error, so
 *     the reading is unavailable, never 0.
 *   - BOUNDED: the PR list is one page of 100 (`truncated` when GitHub reports a next page); a head's suites are
 *     one page of 100 (`incomplete` when `total_count` exceeds it).
 *   - GREEN_IS_ALL_SUITES_DONE: a head is green only when it has at least one suite WITH CHECK RUNS and every such
 *     suite is completed with `success`, `neutral` or `skipped`. A suite with `latest_check_runs_count === 0` (a
 *     subscribed App that never reported) is ignored. Its green instant is the latest suite `updated_at`.
 *   - NO_HARDCODED_IDENTITY: the repo comes from the caller and the App id from operator env.
 * Side-effects: IO (outbound HTTPS to api.github.com)
 * Links: ports/candidate-backlog.port.ts, adapters/server/review/github-auth.ts, task.5498
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";
import type { Octokit } from "@octokit/core";
import type {
  CandidateBacklogSourcePort,
  CandidateOpenPr,
  CandidateRepo,
} from "@/ports";
import { createInstallationOctokit } from "./github-auth";

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 100;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

interface PullNode {
  number?: number;
  draft?: boolean;
  created_at?: string;
  head?: { sha?: string };
}
interface SuiteNode {
  /** Check runs in the suite; 0 = a subscribed App that never reported (the suite stays `queued`). */
  latest_check_runs_count?: number;
  status?: string | null;
  conclusion?: string | null;
  updated_at?: string | null;
}

/** Open non-draft PRs from a GitHub `pulls` page. */
export function mapOpenPulls(nodes: readonly PullNode[]): CandidateOpenPr[] {
  const out: CandidateOpenPr[] = [];
  for (const n of nodes) {
    if (n.draft === true) continue;
    if (n.number === undefined || !n.head?.sha || !n.created_at) continue;
    out.push({
      number: n.number,
      headSha: n.head.sha.toLowerCase(),
      createdAt: new Date(n.created_at),
    });
  }
  return out;
}

/** The green instant of a head from its check suites (see GREEN_IS_ALL_SUITES_DONE). */
export function greenInstant(
  allSuites: readonly SuiteNode[]
): Date | undefined {
  // GitHub creates a suite for every subscribed App; one that never got a run stays `queued` with no
  // conclusion forever. It is not CI, so it neither blocks nor times the green.
  const suites = allSuites.filter((s) => s.latest_check_runs_count !== 0);
  if (suites.length === 0) return undefined;
  let latest = 0;
  for (const s of suites) {
    if (s.status !== "completed" || !GREEN_CONCLUSIONS.has(s.conclusion ?? ""))
      return undefined;
    latest = Math.max(latest, Date.parse(s.updated_at ?? ""));
  }
  return Number.isFinite(latest) && latest > 0 ? new Date(latest) : undefined;
}

export interface GitHubCandidateBacklogSourceConfig {
  /** The review App (`GH_REVIEW_APP_ID`) and its key: the only credential used. */
  readonly appId: string;
  readonly privateKeyBase64: string;
}

type Requester = Pick<Octokit, "request">;

export class GitHubCandidateBacklogSource
  implements CandidateBacklogSourcePort
{
  private readonly byRepo = new Map<string, Requester>();

  constructor(
    private readonly config: GitHubCandidateBacklogSourceConfig,
    private readonly clock: () => Date = () => new Date(),
    /** Test seam: a ready Octokit-shaped client for every repo. */
    private readonly clientOverride?: Requester
  ) {}

  private async client(
    repo: CandidateRepo,
    signal: AbortSignal
  ): Promise<Requester> {
    if (this.clientOverride) return this.clientOverride;
    if (!SAFE_NAME.test(repo.owner) || !SAFE_NAME.test(repo.repo))
      throw new Error("candidate_backlog_repo_invalid");
    if (!/^\d+$/.test(this.config.appId))
      throw new Error("candidate_backlog_app_id_invalid");
    const key = `${repo.owner}/${repo.repo}`;
    const cached = this.byRepo.get(key);
    if (cached) return cached;
    const privateKey = Buffer.from(
      this.config.privateKeyBase64,
      "base64"
    ).toString("utf-8");
    const { token } = await createAppAuth({
      appId: this.config.appId,
      privateKey,
    })({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      }
    );
    if (!response.ok)
      throw new Error(`App not installed on ${key} (HTTP ${response.status})`);
    const installationId = ((await response.json()) as { id: number }).id;
    const octokit = createInstallationOctokit(
      installationId,
      this.config.appId,
      this.config.privateKeyBase64,
      REQUEST_TIMEOUT_MS
    );
    this.byRepo.set(key, octokit);
    return octokit;
  }

  async openPullRequests(input: {
    readonly repo: CandidateRepo;
    readonly maxPrs: number;
    readonly signal: AbortSignal;
  }) {
    input.signal.throwIfAborted();
    const octokit = await this.client(input.repo, input.signal);
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: input.repo.owner,
      repo: input.repo.repo,
      state: "open",
      sort: "created",
      direction: "asc",
      per_page: Math.min(PAGE, input.maxPrs),
      request: { signal: input.signal },
    });
    const link = String((res.headers as Record<string, unknown>).link ?? "");
    return {
      prs: mapOpenPulls(res.data as PullNode[]),
      truncated: /rel="next"/.test(link),
      asOf: this.clock(),
    };
  }

  async ciGreenAt(input: {
    readonly repo: CandidateRepo;
    readonly headSha: string;
    readonly signal: AbortSignal;
  }) {
    input.signal.throwIfAborted();
    if (!/^[0-9a-f]{40}$/i.test(input.headSha))
      throw new Error("candidate_backlog_sha_invalid");
    const octokit = await this.client(input.repo, input.signal);
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
      {
        owner: input.repo.owner,
        repo: input.repo.repo,
        ref: input.headSha,
        per_page: PAGE,
        request: { signal: input.signal },
      }
    );
    const data = res.data as {
      total_count?: number;
      check_suites?: SuiteNode[];
    };
    const suites = data.check_suites ?? [];
    return {
      green: greenInstant(suites),
      incomplete: (data.total_count ?? suites.length) > suites.length,
    };
  }
}
