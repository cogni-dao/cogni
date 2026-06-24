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
 *   - NODE_SCOPED_OR_LEGACY: with `nodeId` (id-or-slug), authorized via `resolveNodeAndAuthorize`
 *     against THAT node (reusing `can_flight`) and the merge target is the node's catalog
 *     `source_repo` — an agent holding RBAC for a node may merge any PR to that node's repo,
 *     INCLUDING a PR it authored from its own fork (the owner-granted RBAC tuple IS the trust
 *     boundary; no self-merge / probation check). WITHOUT `nodeId`, the KEPT LEGACY lane runs:
 *     authorized against the OPERATOR node (slug `operator`) + merge target = the operator's own
 *     monorepo (`NODE_SUBMODULE_PARENT_*`). NOTE: gating the single most IRREVERSIBLE repo action
 *     (merge-to-main) on `can_flight` is a deliberate least-privilege MVP concession — a dedicated
 *     `can_merge` role + probation tier is the COMMITTED vNext. The seam FAILS CLOSED (503) when no
 *     authority is configured.
 *   - NO_REPO_FROM_AGENT: owner/repo are operator-resolved (node catalog `source_repo`, or the
 *     monorepo env), never the body (anti-spoof).
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

/** Merging the monorepo is the operator node's authority — gate on it, not the body. */
const OPERATOR_NODE_SLUG = "operator";

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
    const { prNumber, method, nodeId } = parsed.data;

    // 2. RBAC — the ONE node-authz seam, reusing can_flight. node-scoped (the named node) when
    //    `nodeId` is supplied; else the operator node (legacy monorepo lane). Fails closed (503)
    //    when no authority is configured (see NODE_SCOPED_OR_LEGACY).
    const rbac = await resolveNodeAndAuthorize({
      id: nodeId ?? OPERATOR_NODE_SLUG,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!rbac.ok) {
      const error =
        rbac.errorCode === "authz_unavailable"
          ? "authorization unavailable"
          : rbac.errorCode === "node_not_found"
            ? nodeId
              ? "node not found"
              : "operator node not found"
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

    // 4. Merge target (operator-resolved, anti-spoof):
    //      nodeId present → the NAMED node's own repo (catalog `source_repo`). An explicit nodeId
    //        must resolve to ITS OWN repo — `catalog_missing` is a hard 404, NEVER a silent retarget
    //        to the monorepo (NODE_SCOPED_NEVER_RETARGETS).
    //      nodeId absent  → the operator's own monorepo (env-scoped legacy lane).
    const env = serverEnv();
    let owner: string | undefined;
    let repo: string | undefined;
    if (nodeId) {
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
          code === "catalog_missing"
            ? "catalog_missing"
            : "node_repo_unresolved",
          code === "catalog_missing"
            ? "node repo not resolvable from catalog"
            : "node repo could not be resolved",
          { prNumber, slug: rbac.node.slug }
        );
      }
    } else {
      owner = env.NODE_SUBMODULE_PARENT_OWNER;
      repo = env.NODE_SUBMODULE_PARENT_REPO;
    }
    if (!owner || !repo) {
      return fail(
        503,
        "merge_target_not_configured",
        "merge target repo not configured",
        { prNumber }
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
