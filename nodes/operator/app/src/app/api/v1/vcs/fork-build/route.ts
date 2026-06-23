// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/fork-build`
 * Purpose: Agent-initiated, operator-executed TRUSTED-CONTEXT build of an approved
 *   FORK PR (FORK_FREEDOM). A fork PR's own `pull_request` event runs with a
 *   read-only GITHUB_TOKEN and no `packages: write`, so `pr-build.yml`'s same-repo
 *   `resolve` gate skips it → no image is built → the fork's code can never flight
 *   to candidate-a. The external agent (e.g. `flock-leader`, read-only on GitHub)
 *   can't `gh workflow run`; it calls this route and the operator GitHub App
 *   (`actions:write`) dispatches `pr-build.yml`'s `workflow_dispatch` trigger on its
 *   behalf — the App is the sole GitHub-privilege bridge AND the trust gate.
 * Scope: Auth → developer RBAC → dispatch. Wraps `VcsCapability.dispatchForkPrBuild`;
 *   adds NO deploy-brain / script / workflow logic (freeze-policy compliant — the
 *   one pipeline `pr-build.yml` is reused, not duplicated). Replaces the standalone
 *   `fork-pr-build.yml` workflow_dispatch that ANYONE with repo access could trigger.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - BUILD_AUTHORITY_IS_OPERATOR_NODE: authorized through the shared
 *     `resolveNodeAndAuthorize` seam against the OPERATOR node (slug `operator`),
 *     reusing `can_flight` — building a fork PR's images so they can flight is an
 *     operator-repo authority, exactly the developer-RBAC gate the bare
 *     workflow_dispatch lacked. Sibling of the merge route's RBAC gate. FAILS
 *     CLOSED (503) when no authority is configured.
 *   - NO_REPO_FROM_AGENT: the BASE repo (where the workflow runs, holds the GHCR
 *     token) is env-resolved (the operator's own monorepo), never the body. The
 *     agent supplies only which fork tree to build (prNumber + headRepo + headSha).
 *   - TRUSTED_CONTEXT_IS_GHCR_PUSH_ONLY: the dispatched run's perms are
 *     contents:read + packages:write (declared in pr-build.yml) — the fork code
 *     never sees a deploy/infra/promote secret; the only elevation vs the fork's
 *     own run is a GHCR-push token, which is the whole point.
 *   - NO_AUTO_TRIGGER: this is dispatch-only — there is no pull_request_target on
 *     fork code; a build runs ONLY after this RBAC-gated call.
 *   - CONTRACTS_ARE_TRUTH: input/output parsed through `forkBuildOperation`.
 * Side-effects: IO (DB read for RBAC, GitHub workflow_dispatch via VcsCapability).
 * Links: packages/node-contracts/src/vcs.fork-build.v1.contract.ts,
 *   .github/workflows/pr-build.yml, nodes/operator/app/src/app/api/v1/vcs/merge/route.ts,
 *   nodes/operator/app/src/app/_lib/node-rbac.ts
 * @public
 */

import { forkBuildOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { stubVcsCapability } from "@/bootstrap/capabilities/vcs";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";

/** Building a fork PR's flightable images is the operator node's authority — gate on it, not the body. */
const OPERATOR_NODE_SLUG = "operator";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.fork-build", auth: { mode: "required", getSessionUser } },
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
          event: EVENT_NAMES.VCS_FORK_BUILD_REQUEST_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          status,
          errorCode,
          durationMs: durationMs(),
          ...extra,
        },
        EVENT_NAMES.VCS_FORK_BUILD_REQUEST_COMPLETE
      );
      return NextResponse.json({ error, errorCode }, { status });
    };

    // 1. Validate input. The BASE repo is NOT accepted from the agent.
    const parsed = forkBuildOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "validation_error", "Invalid request");
    }
    const { prNumber, headRepo, headSha } = parsed.data;

    // 2. RBAC — the ONE node-authz seam, against the operator node, reusing can_flight.
    //    Sibling of the merge gate; fails closed (503) when no authority is configured.
    const rbac = await resolveNodeAndAuthorize({
      id: OPERATOR_NODE_SLUG,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!rbac.ok) {
      const error =
        rbac.errorCode === "authz_unavailable"
          ? "authorization unavailable"
          : rbac.errorCode === "node_not_found"
            ? "operator node not found"
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

    // 4. Dispatch target = the operator's own monorepo (env-scoped, anti-spoof).
    //    This is the BASE repo where pr-build.yml lives and the GHCR token is held.
    const env = serverEnv();
    const owner = env.NODE_SUBMODULE_PARENT_OWNER;
    const repo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!owner || !repo) {
      return fail(
        503,
        "build_target_not_configured",
        "build target repo not configured",
        { prNumber }
      );
    }

    // 5. Dispatch the trusted-context fork build.
    try {
      const result = await vcs.dispatchForkPrBuild({
        owner,
        repo,
        prNumber,
        headRepo,
        headSha,
      });

      logEvent(
        ctx.log,
        EVENT_NAMES.VCS_FORK_BUILD_REQUEST_COMPLETE,
        {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "success",
          status: 200,
          prNumber,
          headRepo,
          headSha8: headSha.slice(0, 8),
          durationMs: durationMs(),
        },
        EVENT_NAMES.VCS_FORK_BUILD_REQUEST_COMPLETE
      );

      return NextResponse.json(forkBuildOperation.output.parse(result), {
        status: 200,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "fork build dispatch failed";
      return fail(502, "dispatch_failed", message, { prNumber });
    }
  }
);
