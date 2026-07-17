// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/merge`
 * Purpose: Agent-initiated, operator-executed merge of a green operator-monorepo PR into `main`.
 *   The external agent (e.g. `flock-leader`, read-only on GitHub) can never `gh pr merge`; it
 *   calls this route and the operator GitHub App performs the merge on its behalf — the App is
 *   the sole GitHub-privilege bridge.
 * Scope: Auth → RBAC → CI/state gate → merge. Wraps the existing `VcsCapability.mergePr`; adds NO
 *   deploy-brain / script / workflow logic (freeze-policy compliant).
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - NODE_SCOPED: `nodeId` (id-or-slug) is REQUIRED — every merge, including the operator's own
 *     monorepo PRs (`nodeId:operator`), is addressed by node. Authorized via `resolveNodeAndAuthorize`
 *     against THAT node (reusing `can_flight`); an agent holding RBAC for a node may merge any PR to
 *     that node's repo, INCLUDING a PR it authored from its own fork (the owner-granted RBAC tuple IS
 *     the trust boundary; no self-merge / probation check). The merge target is resolved by ONE path
 *     (`resolveNodeRepo`): an in-repo node (the operator, no catalog `source_repo`) → the parent
 *     monorepo; a remote-source node → its own `source_repo`. There is NO `nodeId`-less / env-direct
 *     legacy lane. NOTE: gating the single most IRREVERSIBLE repo action (merge-to-main) on
 *     `can_flight` is a deliberate least-privilege MVP concession — a dedicated `can_merge` role +
 *     probation tier is the COMMITTED vNext. The seam FAILS CLOSED (503) when no authority is configured.
 *   - NODE_SCOPED_NEVER_RETARGETS: only a KNOWN in-repo node (operator) retargets to the monorepo; a
 *     typo'd / unknown slug hard-404s (`catalog_missing`), never a silent retarget.
 *   - NO_REPO_FROM_AGENT: owner/repo are operator-resolved via `resolveNodeRepo` (the node's catalog
 *     row), never the body (anti-spoof).
 *   - BRANCH_PROTECTION_IS_AUTHORITY: GitHub independently rejects a non-green merge (405); the
 *     `evaluateMergeGate` pre-check is fast-fail UX + clear errors, not the sole gate.
 *   - MERGED_XOR_ENQUEUED: `mergePr` is queue-tolerant — when the base requires a merge queue it
 *     enqueues (returns `enqueued`, no `sha`; merge completes async on the rebased candidate),
 *     else it direct-merges (`merged` + `sha`). Both are 200; only neither is a failure.
 *   - NO_SEPARATION_OF_DUTIES (V0): autonomous self-merge on green is intended ("no human required
 *     for routine merges"); a second-reviewer policy is vNext. The operator-App execution boundary
 *     is the structural control today.
 *   - CONTRACTS_ARE_TRUTH: input/output parsed through `mergeOperation`.
 * Side-effects: IO (DB read, GitHub REST merge via VcsCapability).
 * Links: packages/node-contracts/src/vcs.merge.v1.contract.ts,
 *   nodes/operator/app/src/features/vcs/merge-gate.ts,
 *   nodes/operator/app/src/app/_lib/node-rbac.ts, docs/spec/development-lifecycle.md
 * @public
 */

import { mergeOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { stubVcsCapability } from "@/bootstrap/capabilities/vcs";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { classifyGithubOpError } from "@/features/vcs/github-op-error";
import {
  classifyMergeFailure,
  evaluateMergeGate,
} from "@/features/vcs/merge-gate";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.merge", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);

    const fail = (
      status: number,
      errorCode: string,
      error: string,
      extra: Record<string, unknown> = {}
    ): NextResponse => {
      const level = status >= 500 ? "error" : "warn";
      ctx.log[level](
        {
          event: EVENT_NAMES.VCS_MERGE_REQUEST_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          status,
          errorCode,
          durationMs: durationMs(),
          ...extra,
        },
        EVENT_NAMES.VCS_MERGE_REQUEST_COMPLETE
      );
      return NextResponse.json({ error, errorCode }, { status });
    };

    // 1. Validate input. owner/repo are NOT accepted from the agent.
    const parsed = mergeOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "validation_error", "Invalid request");
    }
    const { prNumber, nodeId } = parsed.data;
    const method = parsed.data.method ?? "squash";

    // 2. RBAC — the ONE node-authz seam, reusing can_flight, against the named node (the operator is
    //    addressed by its own `nodeId` like any node — see NODE_SCOPED). Fails closed (503) when no
    //    authority is configured.
    const rbac = await resolveNodeAndAuthorize({
      id: nodeId,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!rbac.ok) {
      const error =
        rbac.errorCode === "authz_unavailable"
          ? "authorization unavailable"
          : rbac.errorCode === "node_not_found"
            ? "node not found"
            : "not authorized";
      return fail(rbac.status, rbac.errorCode, error, { prNumber });
    }

    // 3. VcsCapability configured? (stub throws on use — detect structurally.)
    const vcs = getContainer().vcsCapability;
    if (vcs === stubVcsCapability) {
      return fail(503, "vcs_not_configured", "VCS not configured", {
        prNumber,
      });
    }

    // 4. Merge target (operator-resolved, anti-spoof): ONE resolution path for every node via
    //    `resolveNodeRepo`. An in-repo node (the operator, no catalog `source_repo`) resolves to the
    //    parent monorepo; a remote-source node to its own `source_repo`. A typo'd / unknown slug
    //    hard-404s (`catalog_missing`) — NEVER a silent retarget (NODE_SCOPED_NEVER_RETARGETS). There
    //    is no env-direct lane and no per-site operator special-case.
    const env = serverEnv();
    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return fail(
        503,
        "merge_target_not_configured",
        "merge target repo not configured",
        { prNumber }
      );
    }
    let owner: string;
    let repo: string;
    try {
      const nodeRepo = await createOperatorDeployPlane(env).resolveNodeRepo({
        parentOwner,
        parentRepo,
        slug: rbac.node.slug,
      });
      owner = nodeRepo.owner;
      repo = nodeRepo.repo;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      return fail(
        code === "catalog_missing" ? 404 : 503,
        code === "catalog_missing" ? "catalog_missing" : "node_repo_unresolved",
        code === "catalog_missing"
          ? "node repo not resolvable from catalog"
          : "node repo could not be resolved",
        { prNumber, slug: rbac.node.slug }
      );
    }

    // 5. CI / state gate (fast-fail; GitHub branch protection is the real backstop).
    //    Guard the read: a node-scoped target may be a repo the App isn't installed on, or the PR
    //    may not exist — emit the terminal event with a coded status, never an opaque 500.
    let ci: Awaited<ReturnType<typeof vcs.getCiStatus>>;
    try {
      ci = await vcs.getCiStatus({ owner, repo, prNumber });
    } catch (error) {
      const g = classifyGithubOpError(error);
      return fail(g.status, g.errorCode, g.error, { prNumber });
    }
    const prCtx = {
      prNumber,
      prAuthor: ci.author,
      baseBranch: ci.baseBranch,
      allGreen: ci.allGreen,
    };
    const rejection = evaluateMergeGate(ci);
    if (rejection) {
      return fail(
        rejection.status,
        rejection.errorCode,
        rejection.error,
        prCtx
      );
    }

    // 6. Merge — direct when no queue is required, else added to the merge queue
    //    (async). Classify failure on the surfaced GitHub HTTP status.
    let result: Awaited<ReturnType<typeof vcs.mergePr>>;
    try {
      result = await vcs.mergePr({ owner, repo, prNumber, method });
    } catch (error) {
      const g = classifyGithubOpError(error);
      return fail(g.status, g.errorCode, g.error, prCtx);
    }
    // Failure = neither merged nor enqueued.
    if (!result.merged && !result.enqueued) {
      const f = classifyMergeFailure(result.status, result.message);
      return fail(f.status, f.errorCode, f.error, {
        ...prCtx,
        githubStatus: result.status,
      });
    }

    // 7. Success — merged synchronously, or enqueued (merge completes async on
    //    the queue's rebased candidate; no merge SHA yet — callers must poll).
    const enqueued = result.enqueued === true;
    logEvent(
      ctx.log,
      EVENT_NAMES.VCS_MERGE_REQUEST_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "success",
        status: 200,
        prNumber,
        prAuthor: ci.author,
        enqueued,
        mergeSha8: result.sha?.slice(0, 8),
        durationMs: durationMs(),
      },
      EVENT_NAMES.VCS_MERGE_REQUEST_COMPLETE
    );

    return NextResponse.json(
      mergeOperation.output.parse({
        merged: result.merged,
        enqueued,
        prNumber,
        // exactOptionalPropertyTypes: omit `sha` entirely on the enqueued path.
        ...(result.sha ? { sha: result.sha } : {}),
        baseBranch: "main",
        method,
        message: result.message,
      }),
      { status: 200 }
    );
  }
);
