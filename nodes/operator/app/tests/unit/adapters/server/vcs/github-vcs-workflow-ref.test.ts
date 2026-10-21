// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-vcs-workflow-ref`
 * Purpose: Prove reviewed workflow refs include main before exact-SHA dispatch.
 * Scope: Mocked Octokit/fetch; does not access GitHub.
 * Invariants: DEFAULT_MAIN_UNCHANGED, EXACT_REVIEWED_HEAD, IMMUTABLE_REF_NEVER_MOVES.
 * Side-effects: none
 * Links: bug.5455, src/adapters/server/vcs/reviewed-workflow-ref.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RequestHandler = (
  route: string,
  params: Record<string, unknown>
) => Promise<unknown> | unknown;

let onRequest: RequestHandler;
const requests: Array<{
  readonly route: string;
  readonly params: Record<string, unknown>;
}> = [];

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));

vi.mock("@octokit/core", () => ({
  Octokit: class MockOctokit {
    async request(route: string, params: Record<string, unknown>) {
      requests.push({ route, params });
      return { data: await onRequest(route, params) };
    }
  },
}));

import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";

const SOURCE_SHA = "c1ff7ca73d0012b1b441f846657c090a9e4476c6";
const WORKFLOW_REF = "bug.5447-lane-local-substrate";
const DISPATCH =
  "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";

function adapter(): GitHubVcsAdapter {
  return new GitHubVcsAdapter({ appId: "1", privateKey: "k" });
}

function statusError(
  status: number,
  message: string
): Error & { readonly status: number } {
  return Object.assign(new Error(message), { status });
}

function reviewedHandlers(options?: {
  readonly resolvedSha?: string;
  readonly headRepo?: string;
  readonly dispatchRefSha?: string | null;
  readonly draft?: boolean;
  readonly state?: string;
  readonly baseRef?: string;
  readonly mainComparison?: string;
}): RequestHandler {
  const resolvedSha = options?.resolvedSha ?? SOURCE_SHA;
  const headRepo = options?.headRepo ?? "Cogni-DAO/cogni";
  const dispatchRefSha = options?.dispatchRefSha ?? null;
  return (route, params) => {
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
      expect(params.ref).toBe(WORKFLOW_REF);
      return { sha: resolvedSha };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls") {
      return [
        {
          number: 2691,
          html_url: "https://github.com/Cogni-DAO/cogni/pull/2691",
          state: options?.state ?? "open",
          draft: options?.draft ?? false,
          base: { ref: options?.baseRef ?? "main" },
          head: { sha: resolvedSha, repo: { full_name: headRepo } },
        },
      ];
    }
    if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
      expect(params.basehead).toBe(`main...${resolvedSha}`);
      return { status: options?.mainComparison ?? "ahead" };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      if (dispatchRefSha === null) throw statusError(404, "Not Found");
      return { object: { sha: dispatchRefSha } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") return {};
    if (route === DISPATCH) return {};
    throw new Error(`Unhandled route: ${route}`);
  };
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42 }),
    }))
  );
});

describe("GitHubVcsAdapter candidate workflow refs", () => {
  it("preserves the ordinary main dispatch without review or ref writes", async () => {
    onRequest = (route) => {
      if (route === DISPATCH) return {};
      throw new Error(`Unexpected route: ${route}`);
    };

    await adapter().dispatchCandidateFlight({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "operator",
      sourceSha: SOURCE_SHA,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toMatchObject({
      ref: "main",
      inputs: { node_slug: "operator", source_sha: SOURCE_SHA },
    });
  });

  it("dispatches an operator-created content-addressed ref with an exact-SHA guard", async () => {
    onRequest = reviewedHandlers();

    await adapter().dispatchCandidateFlight({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "operator",
      sourceSha: SOURCE_SHA,
      workflowRef: WORKFLOW_REF,
    });

    expect(
      requests.find(
        ({ route }) => route === "POST /repos/{owner}/{repo}/git/refs"
      )?.params
    ).toMatchObject({
      ref: `refs/heads/cogni-flight/${SOURCE_SHA}`,
      sha: SOURCE_SHA,
    });
    expect(
      requests.find(({ route }) => route === DISPATCH)?.params
    ).toMatchObject({
      ref: `cogni-flight/${SOURCE_SHA}`,
      inputs: {
        pr_number: "2691",
        head_sha: SOURCE_SHA,
      },
    });
  });

  it.each([
    "behind",
    "diverged",
  ])("rejects an old reviewed workflow %s current main before any ref write", async (status) => {
    onRequest = reviewedHandlers({ mainComparison: status });
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({
      code: "workflow_ref_missing_current_main",
      status: 422,
    });
    expect(requests.some(({ route }) => route.startsWith("POST "))).toBe(false);
  });

  it("accepts an identical current-main comparison and fails closed on unknown comparison", async () => {
    onRequest = reviewedHandlers({ mainComparison: "identical" });
    await adapter().dispatchCandidateFlight({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "operator",
      sourceSha: SOURCE_SHA,
      workflowRef: WORKFLOW_REF,
    });
    requests.length = 0;
    onRequest = reviewedHandlers({ mainComparison: "unknown" });
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({
      code: "workflow_ref_main_ancestry_unavailable",
      status: 503,
    });
    expect(requests.some(({ route }) => route.startsWith("POST "))).toBe(false);
  });

  it("propagates an unavailable comparison without creating or dispatching a ref", async () => {
    const normal = reviewedHandlers();
    const unavailable = statusError(503, "owned GitHub unavailable");
    onRequest = (route, params) => {
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}")
        throw unavailable;
      return normal(route, params);
    };
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toBe(unavailable);
    expect(requests.some(({ route }) => route.startsWith("POST "))).toBe(false);
  });

  it("normalizes a case-insensitive source SHA to GitHub's canonical resolved SHA", async () => {
    onRequest = reviewedHandlers();

    await adapter().dispatchCandidateFlight({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "operator",
      sourceSha: SOURCE_SHA.toUpperCase(),
      workflowRef: WORKFLOW_REF,
    });

    expect(
      requests.find(({ route }) => route === DISPATCH)?.params
    ).toMatchObject({
      inputs: {
        pr_number: "2691",
        head_sha: SOURCE_SHA,
      },
    });
  });

  it("fails closed when the content-addressed ref was moved", async () => {
    onRequest = reviewedHandlers({
      dispatchRefSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({
      code: "workflow_dispatch_ref_mismatch",
      status: 409,
    });
    expect(requests.some(({ route }) => route === DISPATCH)).toBe(false);
    expect(
      requests.some(
        ({ route }) => route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}"
      )
    ).toBe(false);
  });

  it("re-reads and verifies the ref when another dispatcher wins the create race", async () => {
    let refReads = 0;
    onRequest = async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        refReads += 1;
        if (refReads === 1) throw statusError(404, "Not Found");
        return { object: { sha: SOURCE_SHA } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        throw statusError(422, "Reference already exists");
      }
      return reviewedHandlers({ dispatchRefSha: SOURCE_SHA })(route, params);
    };

    await adapter().dispatchCandidateFlight({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "operator",
      sourceSha: SOURCE_SHA,
      workflowRef: WORKFLOW_REF,
    });

    expect(refReads).toBe(2);
    expect(
      requests.find(({ route }) => route === DISPATCH)?.params
    ).toMatchObject({
      ref: `cogni-flight/${SOURCE_SHA}`,
    });
  });

  it("rejects mutable mismatches and cross-repository PR heads before ref creation", async () => {
    onRequest = reviewedHandlers({
      resolvedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({ code: "workflow_ref_source_mismatch" });

    requests.length = 0;
    onRequest = reviewedHandlers({ headRepo: "attacker/cogni" });
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({ code: "workflow_ref_cross_repo_source" });

    expect(
      requests.some(
        ({ route }) => route === "POST /repos/{owner}/{repo}/git/refs"
      )
    ).toBe(false);
    expect(requests.some(({ route }) => route === DISPATCH)).toBe(false);
  });

  it("rejects a matching commit that is not an open PR head", async () => {
    onRequest = (route) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { sha: SOURCE_SHA };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls") {
        return [];
      }
      throw new Error(`Unexpected route: ${route}`);
    };

    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({ code: "workflow_ref_unreviewed_source" });
    expect(requests.some(({ route }) => route === DISPATCH)).toBe(false);
  });

  it("rejects a draft PR and a raw SHA workflow ref", async () => {
    onRequest = reviewedHandlers({ draft: true });
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({ code: "workflow_ref_unreviewed_source" });

    requests.length = 0;
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: SOURCE_SHA,
      })
    ).rejects.toMatchObject({ code: "invalid_workflow_ref" });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["closed PR", { state: "closed" }],
    ["non-main PR", { baseRef: "release" }],
  ])("rejects a %s", async (_label, options) => {
    onRequest = reviewedHandlers(options);
    await expect(
      adapter().dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "operator",
        sourceSha: SOURCE_SHA,
        workflowRef: WORKFLOW_REF,
      })
    ).rejects.toMatchObject({ code: "workflow_ref_unreviewed_source" });
    expect(requests.some(({ route }) => route === DISPATCH)).toBe(false);
  });
});
