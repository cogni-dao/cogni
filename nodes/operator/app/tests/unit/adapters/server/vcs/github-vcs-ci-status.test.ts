// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-vcs-ci-status`
 * Purpose: Pin the merge-gate greenness semantics of `getCiStatus` (bug.5123):
 *   REQUIRED_CHECKS_ARE_GITHUB_DEFINED and fail-closed on an unprotected branch.
 *   (1) An empty required-context set is NEVER green — even when every check on the
 *   head sha (including advisory app checks) succeeded. Healing an unprotected node
 *   repo goes through the protection-reconcile verb, never by loosening this gate.
 *   (2) Advisory (non-github-actions) app checks — e.g. "Cogni Git PR Review" —
 *   never gate: a failing advisory check cannot block a PR whose GitHub-required
 *   set is satisfied, and a passing one cannot green an unprotected branch.
 * Scope: Mocked Octokit + `fetch`; no real GitHub I/O.
 * Invariants: EMPTY_REQUIRED_SET_IS_NOT_GREEN, ADVISORY_CHECKS_NEVER_GATE,
 *   REQUIRED_CHECK_PRODUCER_IS_BOUND, REVIEW_PAGINATION_FAILS_CLOSED.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-vcs.adapter.ts (getCiStatus),
 *   src/features/vcs/merge-gate.ts, bug.5123
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RequestHandler = (
  route: string,
  params: Record<string, unknown>
) => Promise<unknown> | unknown;

let onRequest: RequestHandler;
const requestRoutes: string[] = [];

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));

vi.mock("@octokit/core", () => ({
  Octokit: class MockOctokit {
    async request(route: string, params: Record<string, unknown>) {
      requestRoutes.push(route);
      return { data: await onRequest(route, params) };
    }
  },
}));

import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";
import { evaluateMergeGate } from "@/features/vcs/merge-gate";

function adapter(): GitHubVcsAdapter {
  return new GitHubVcsAdapter({ appId: "1", privateKey: "k" });
}

const PR_GET_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const CHECK_RUNS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/check-runs";
const STATUS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/status";
const COMMIT_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}";
const REVIEWS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const CLASSIC_REQUIRED_CHECKS_ROUTE =
  "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks";
const ACTIVE_BRANCH_RULES_ROUTE =
  "GET /repos/{owner}/{repo}/rules/branches/{branch}";

const STANDARD_CONTEXTS = ["unit", "component", "static", "manifest"] as const;

/** The standard CI set, all green, produced by GitHub Actions. */
const GREEN_STANDARD_RUNS = STANDARD_CONTEXTS.map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
}));

function statusError(
  status: number,
  message: string
): Error & { readonly status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Serve a full getCiStatus round-trip: PR metadata, head-sha checks, and the
 * branch's required-context sources (classic 404 = no classic protection).
 */
function ciHandlers(input: {
  checkRuns: ReadonlyArray<Record<string, unknown>>;
  activeRules: ReadonlyArray<Record<string, unknown>>;
  statuses?: ReadonlyArray<Record<string, unknown>>;
  classicRequiredChecks?: Record<string, unknown>;
  reviews?: ReadonlyArray<Record<string, unknown>>;
  nextReviews?: ReadonlyArray<Record<string, unknown>>;
}): RequestHandler {
  return (route, params) => {
    if (route === PR_GET_ROUTE) {
      return {
        number: 5,
        title: "test pr",
        user: { login: "dev" },
        base: { ref: "main", sha: "basesha" },
        head: { sha: "headsha", ref: "feat/x" },
        mergeable: true,
        labels: [],
        draft: false,
      };
    }
    if (route === CHECK_RUNS_ROUTE) return { check_runs: input.checkRuns };
    if (route === STATUS_ROUTE) return { statuses: input.statuses ?? [] };
    if (route === REVIEWS_ROUTE) {
      return params.page === 2
        ? (input.nextReviews ?? [])
        : (input.reviews ?? []);
    }
    if (route === COMMIT_ROUTE) {
      return {
        parents: [{ sha: "basesha" }],
        commit: { message: "test commit" },
      };
    }
    if (route === CLASSIC_REQUIRED_CHECKS_ROUTE) {
      if (input.classicRequiredChecks) return input.classicRequiredChecks;
      throw statusError(404, "Branch not protected");
    }
    if (route === ACTIVE_BRANCH_RULES_ROUTE) return input.activeRules;
    throw new Error(`Unhandled request route: ${route}`);
  };
}

beforeEach(() => {
  requestRoutes.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42 }),
    }))
  );
});

describe("GitHubVcsAdapter.getCiStatus — merge-gate greenness (bug.5123)", () => {
  it("is NOT green on an unprotected branch even when every check (advisory included) succeeded", async () => {
    // poly/levelup/toks4 pre-reconcile state: no classic protection, only a
    // merge-queue ruleset with zero required checks → empty required set.
    onRequest = ciHandlers({
      checkRuns: [
        ...GREEN_STANDARD_RUNS,
        {
          name: "Cogni Git PR Review",
          status: "completed",
          conclusion: "success",
          app: { slug: "cogni-git-review" },
        },
      ],
      activeRules: [
        { type: "merge_queue", parameters: { merge_method: "SQUASH" } },
      ],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(false);
    expect(evaluateMergeGate(ci)).toMatchObject({ errorCode: "not_green" });
  });

  it("a FAILING advisory app check never gates a PR whose GitHub-required set is satisfied", async () => {
    // The advisory review App check fails, but every GitHub-REQUIRED context is
    // green — the gate must pass: greenness is GitHub's required set, nothing else.
    onRequest = ciHandlers({
      checkRuns: [
        ...GREEN_STANDARD_RUNS,
        {
          name: "Cogni Git PR Review",
          status: "completed",
          conclusion: "failure",
          app: { slug: "cogni-git-review" },
        },
      ],
      activeRules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: STANDARD_CONTEXTS.map((context) => ({
              context,
            })),
          },
        },
      ],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(true);
    expect(ci.pending).toBe(false);
    expect(evaluateMergeGate(ci)).toBeNull();
  });

  it("a required context satisfied only by a non-github-actions app is NOT satisfied (no spoofing)", async () => {
    // Same names, wrong producer: only github-actions check runs (or legacy commit
    // statuses) can satisfy a required context.
    onRequest = ciHandlers({
      checkRuns: STANDARD_CONTEXTS.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        app: { slug: "some-third-party-app" },
      })),
      activeRules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: STANDARD_CONTEXTS.map((context) => ({
              context,
            })),
          },
        },
      ],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(false);
    expect(ci.pending).toBe(true);
  });

  it("rejects same-name checks from the wrong App when classic protection binds app_id", async () => {
    onRequest = ciHandlers({
      checkRuns: STANDARD_CONTEXTS.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        app: { id: 999, slug: "github-actions" },
      })),
      classicRequiredChecks: {
        contexts: [...STANDARD_CONTEXTS],
        checks: STANDARD_CONTEXTS.map((context) => ({
          context,
          app_id: 15368,
        })),
      },
      activeRules: [],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(false);
    expect(ci.pending).toBe(true);
  });

  it("accepts a required check only from its ruleset-bound integration", async () => {
    onRequest = ciHandlers({
      checkRuns: STANDARD_CONTEXTS.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
      })),
      activeRules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: STANDARD_CONTEXTS.map((context) => ({
              context,
              integration_id: 15368,
            })),
          },
        },
      ],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(true);
    expect(ci.pending).toBe(false);
  });

  it("legacy statuses cannot satisfy a producer-bound required check", async () => {
    onRequest = ciHandlers({
      checkRuns: [],
      statuses: STANDARD_CONTEXTS.map((context) => ({
        context,
        state: "success",
      })),
      classicRequiredChecks: {
        contexts: [...STANDARD_CONTEXTS],
        checks: STANDARD_CONTEXTS.map((context) => ({
          context,
          app_id: 15368,
        })),
      },
      activeRules: [],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(false);
    expect(ci.pending).toBe(true);
  });

  it("fails closed when the same required producer reports conflicting results", async () => {
    onRequest = ciHandlers({
      checkRuns: [
        ...STANDARD_CONTEXTS.map((name) => ({
          name,
          status: "completed",
          conclusion: "success",
          app: { id: 15368, slug: "github-actions" },
        })),
        {
          name: "unit",
          status: "completed",
          conclusion: "failure",
          app: { id: 15368, slug: "github-actions" },
        },
      ],
      classicRequiredChecks: {
        contexts: [...STANDARD_CONTEXTS],
        checks: STANDARD_CONTEXTS.map((context) => ({
          context,
          app_id: 15368,
        })),
      },
      activeRules: [],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(false);
    expect(ci.pending).toBe(false);
  });

  it("treats classic app_id -1 as an unbound any-producer gate", async () => {
    onRequest = ciHandlers({
      checkRuns: [],
      statuses: STANDARD_CONTEXTS.map((context) => ({
        context,
        state: "success",
      })),
      classicRequiredChecks: {
        contexts: [...STANDARD_CONTEXTS],
        checks: STANDARD_CONTEXTS.map((context) => ({
          context,
          app_id: -1,
        })),
      },
      activeRules: [],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.allGreen).toBe(true);
    expect(ci.pending).toBe(false);
  });

  it("fails closed when reviews exceed the first 100-result page", async () => {
    onRequest = ciHandlers({
      checkRuns: GREEN_STANDARD_RUNS,
      activeRules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: STANDARD_CONTEXTS.map((context) => ({
              context,
            })),
          },
        },
      ],
      reviews: Array.from({ length: 100 }, (_, index) => ({
        user: { login: `reviewer-${index}` },
        state: "APPROVED",
      })),
      nextReviews: [{ user: { login: "hold" }, state: "COMMENTED" }],
    });

    const ci = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 5,
    });

    expect(ci.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(
      requestRoutes.filter((route) => route === REVIEWS_ROUTE)
    ).toHaveLength(2);
  });
});
