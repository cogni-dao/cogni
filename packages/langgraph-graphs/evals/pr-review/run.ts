// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/pr-review/run`
 * Purpose: Thin orchestration for the pr-review eval (story.5102 acceptance): preflight → for each
 *   case POST /api/v1/vcs/review on the candidate → wait for the check whose external_id is the
 *   returned requestId → grade its machine block → scorecard + exit code.
 * Scope: External lane only; does not run in PR CI and does not grade (score.ts does).
 *   Needs a live candidate operator, a node API key, real model calls and GitHub reads.
 * Invariants:
 *   - REQUEST_BOUND_WAIT: the check is matched by external_id === requestId, never by name alone.
 *   - BOUNDED_WAIT: at most 15 minutes per case (EVAL_TIMEOUT_MS); a timeout is unscorable.
 *   - PREFLIGHT_OR_UNSCORABLE: the eval account must have credits (`unfunded_eval_account`) and
 *     the breaks-rule id must be in the candidate's governing index; a refused verb (401/403) is
 *     unscorable, never a fail. Preflight runs before any review call.
 *   - EXIT_CODE_IS_VERDICT: 0 = both cases pass; 1 = a fail; 3 = unscorable; 2 = bad config.
 *   - RESULTS_NOT_COMMITTED: `--out <file>` writes the JSON scorecard wherever the caller chooses.
 * Side-effects: IO (HTTP to the candidate operator and the GitHub REST API; optional --out file)
 * Links: evals/pr-review/README.md, score.ts, https://cognidao.org/knowledge/pr-review-grounded-gate
 * @public
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CaseVerdict,
  type EvalCase,
  exitCodeFor,
  gradeCase,
  parseReviewBlock,
} from "./score";

interface CasesFile {
  repo: { owner: string; repo: string };
  nodeId: string;
  base: string;
  cases: EvalCase[];
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(path.join(DIR, "cases.json"), "utf8")
) as CasesFile;

const strip = (u: string) => u.replace(/\/$/, "");
const BASE = strip(process.env.EVAL_BASE_URL ?? "https://test.cognidao.org");
const KEY = process.env.EVAL_API_KEY ?? process.env.COGNI_NODE_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 15 * 60_000);
const POLL_MS = Number(process.env.EVAL_POLL_MS ?? 15_000);
const CHECK_NAME = "Cogni Git PR Review";
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

if (!KEY) {
  console.error("EVAL_API_KEY or COGNI_NODE_API_KEY is required");
  process.exit(2);
}
const badCase = config.cases.find(
  (c) => !Number.isInteger(c.prNumber) || c.prNumber <= 0
);
if (badCase) {
  console.error(
    `cases.json: case "${badCase.id}" has no PR number yet — create the fixture PRs (README) first`
  );
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cogni<T>(
  method: "GET" | "POST",
  p: string,
  body?: unknown
): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      "user-agent": "curl/8.4.0",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

async function github<T>(p: string): Promise<T> {
  const res = await fetch(`https://api.github.com${p}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cogni-pr-review-eval",
      ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  });
  if (!res.ok)
    throw new Error(`GitHub GET ${p} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * PREFLIGHT_OR_UNSCORABLE: the expected rule id is in the candidate's governing index — the same
 * `governingIndex` the cognition bundle serves and the review's host preamble renders.
 */
async function ruleInGoverningIndex(ruleId: string): Promise<string | null> {
  const bundle = await cogni<{ governingIndex?: Array<{ id: string }> }>(
    "GET",
    "/api/v1/cognition"
  );
  if (bundle.status !== 200 || !Array.isArray(bundle.json?.governingIndex))
    return `cognition_unavailable:${bundle.status}`;
  return bundle.json.governingIndex.some((e) => e.id === ruleId)
    ? null
    : `rule_not_governing:${ruleId}`;
}

/**
 * PREFLIGHT_OR_UNSCORABLE: the requester pays, so an unfunded eval account can only produce
 * "could not evaluate". Refuse before any review call.
 */
async function evalAccountFunded(): Promise<string | null> {
  const res = await cogni<{ balanceCredits?: number }>(
    "GET",
    "/api/v1/payments/credits/summary"
  );
  if (res.status !== 200 || typeof res.json?.balanceCredits !== "number")
    return `credits_unavailable:${res.status}`;
  return res.json.balanceCredits > 0 ? null : "unfunded_eval_account";
}

interface CheckRun {
  external_id: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  output: { title: string | null; summary: string | null };
}

async function waitForCheck(
  headSha: string,
  requestId: string
): Promise<CheckRun | null> {
  const { owner, repo } = config.repo;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await github<{ check_runs: CheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`
    );
    const run = data.check_runs.find((c) => c.external_id === requestId);
    if (run?.status === "completed") return run;
    await sleep(POLL_MS);
  }
  return null;
}

interface CaseCard {
  caseId: string;
  prNumber: number;
  headSha: string | null;
  requestId: string | null;
  checkUrl: string | null;
  model: string | null;
  verdict: CaseVerdict;
}

async function runCase(
  c: EvalCase,
  candidateBuildSha: string
): Promise<CaseCard> {
  const { owner, repo } = config.repo;
  const card = (
    verdict: CaseVerdict,
    extra: Partial<CaseCard> = {}
  ): CaseCard => ({
    caseId: c.id,
    prNumber: c.prNumber,
    headSha: null,
    requestId: null,
    checkUrl: null,
    model: null,
    verdict,
    ...extra,
  });
  const unscorable = (reason: string, extra: Partial<CaseCard> = {}) =>
    card({ caseId: c.id, status: "unscorable", reasons: [reason] }, extra);

  const files = await github<Array<{ filename: string }>>(
    `/repos/${owner}/${repo}/pulls/${c.prNumber}/files?per_page=100`
  );
  const diffFiles = files.map((f) => f.filename);

  const res = await cogni<{
    requestId: string;
    headSha: string;
    errorCode?: string;
  }>("POST", "/api/v1/vcs/review", {
    nodeId: config.nodeId,
    prNumber: c.prNumber,
  });
  if (res.status === 401 || res.status === 403)
    return unscorable(`preflight:verb_refused_${res.status}`);
  if (res.status !== 202 || !res.json?.requestId)
    return unscorable(
      `verb:${res.status}:${res.json?.errorCode ?? res.text.slice(0, 120)}`
    );
  const { requestId, headSha } = res.json;

  const check = await waitForCheck(headSha, requestId);
  const block = parseReviewBlock(check?.output.summary);
  return card(
    gradeCase({
      evalCase: c,
      summary: check?.output.summary,
      requestId,
      candidateBuildSha,
      diffFiles,
      timedOut: check === null,
    }),
    {
      headSha,
      requestId,
      checkUrl: check?.html_url ?? null,
      model: block?.model ?? null,
    }
  );
}

async function main(): Promise<void> {
  const version = await cogni<{ buildSha?: string }>("GET", "/version");
  const candidateBuildSha = version.json?.buildSha;
  if (!candidateBuildSha) {
    console.error(`GET ${BASE}/version returned no buildSha`);
    process.exit(3);
  }

  const preflight: string[] = [];
  const unfunded = await evalAccountFunded();
  if (unfunded) preflight.push(unfunded);
  for (const c of config.cases) {
    if (c.ruleId) {
      const miss = await ruleInGoverningIndex(c.ruleId);
      if (miss) preflight.push(miss);
    }
  }

  const cards: CaseCard[] = preflight.length
    ? config.cases.map((c) => ({
        caseId: c.id,
        prNumber: c.prNumber,
        headSha: null,
        requestId: null,
        checkUrl: null,
        model: null,
        verdict: {
          caseId: c.id,
          status: "unscorable" as const,
          reasons: preflight.map((p) => `preflight:${p}`),
        },
      }))
    : await Promise.all(config.cases.map((c) => runCase(c, candidateBuildSha)));

  const exitCode = exitCodeFor(cards.map((c) => c.verdict));
  const scorecard = {
    eval: "pr-review",
    baseUrl: BASE,
    buildSha: candidateBuildSha,
    repo: `${config.repo.owner}/${config.repo.repo}`,
    base: config.base,
    cases: cards,
    exitCode,
    verdict: exitCode === 0 ? "PASS" : exitCode === 1 ? "FAIL" : "UNSCORABLE",
  };
  console.log(JSON.stringify(scorecard, null, 2));
  if (OUT) writeFileSync(OUT, `${JSON.stringify(scorecard, null, 2)}\n`);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
});
