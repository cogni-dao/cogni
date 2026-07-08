// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/run-ci`
 * Purpose: Node-scoped, operator-executed run-CI for a fork contributor's PR. CI = gate + build:
 *   (1) release GitHub's `action_required` hold on the held `pull_request` gate runs (an external
 *   read-only agent can never click "Approve and run"), and (2) dispatch the trusted pr-build of
 *   the approved head so a flightable `sha-<headSha>` image exists (a fork's read-only run cannot
 *   push the deployable). The operator GitHub App is the sole GitHub-privilege bridge, so the PR
 *   becomes flightable/mergeable with zero privileged human action.
 * Scope: Auth → RBAC (node-scoped) → resolve repo → approve held gate runs → dispatch pr-build.
 *   Wraps `VcsCapability.approveWorkflowRuns` + `DeployPlanePort.dispatchPrBuild`; adds NO
 *   bespoke deploy-brain / new workflow (reuses the SAME pr-build.yml).
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - RBAC_IS_THE_GATE: `node.flight` on the NAMED node authorizes the approval — the owner-granted
 *     RBAC tuple IS the trust boundary. NO work-item linkage, NO self-merge / probation check. An
 *     agent holding RBAC for a node may approve standard CI on any PR to that node's repo, including
 *     a PR it authored from its own fork. The seam FAILS CLOSED (503) when no authority is configured.
 *   - SAFE_BY_STRUCTURE: the adapter approves ONLY standard `pull_request` runs (never
 *     `pull_request_target` / secret-bearing runs) — safety is structural, not a trust check.
 *   - NO_REPO_FROM_AGENT: owner/repo are operator-resolved from the node's catalog `source_repo`,
 *     never the body (anti-spoof). On `catalog_missing` the route surfaces 404 (no legacy fallback).
 *   - CONTRACTS_ARE_TRUTH: input/output parsed through `runCiOperation`.
 * Side-effects: IO (DB read, catalog read + GitHub REST approve + workflow_dispatch via the App).
 * Links: packages/node-contracts/src/vcs.run-ci.v1.contract.ts,
 *   nodes/operator/app/src/app/_lib/node-rbac.ts, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { runCiOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { stubVcsCapability } from "@/bootstrap/capabilities/vcs";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { classifyGithubOpError } from "@/features/vcs/github-op-error";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.runCi", auth: { mode: "required", getSessionUser } },
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
          event: EVENT_NAMES.VCS_RUN_CI_REQUEST_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          status,
          errorCode,
          durationMs: durationMs(),
          ...extra,
        },
        EVENT_NAMES.VCS_RUN_CI_REQUEST_COMPLETE
      );
      return NextResponse.json({ error, errorCode }, { status });
    };

    // 1. Validate input. owner/repo are NOT accepted from the agent.
    const parsed = runCiOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "validation_error", "Invalid request");
    }
    const { nodeId, prNumber } = parsed.data;

    // 2. RBAC — node-scoped, reusing can_flight. Fails closed (503) when no authority configured.
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

    // 4. Resolve the node's OWN repo from its catalog `source_repo` (operator-resolved, anti-spoof).
    const env = serverEnv();
    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return fail(
        503,
        "merge_target_not_configured",
        "parent deployment repo not configured",
        { prNumber }
      );
    }

    let deployPlane: ReturnType<typeof createOperatorDeployPlane>;
    try {
      deployPlane = createOperatorDeployPlane(env);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "deploy plane not configured";
      return fail(503, "deploy_plane_config_missing", message, { prNumber });
    }
    // ONE resolution path (resolveNodeRepo): an in-repo node (the operator, no catalog
    // `source_repo`) resolves to the parent monorepo; a remote-source node to its own repo.
    let owner: string;
    let repo: string;
    try {
      const nodeRepo = await deployPlane.resolveNodeRepo({
        parentOwner,
        parentRepo,
        slug: rbac.node.slug,
      });
      owner = nodeRepo.owner;
      repo = nodeRepo.repo;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "catalog_missing") {
        return fail(404, "catalog_missing", "node catalog entry not found", {
          prNumber,
          slug: rbac.node.slug,
        });
      }
      return fail(
        503,
        "merge_target_not_configured",
        "node repo not resolvable",
        { prNumber, slug: rbac.node.slug }
      );
    }

    // 5. Approve the held fork-PR runs (adapter approves only `pull_request` runs — safe).
    //    Guard the GitHub op: a node repo the App isn't installed on, or a missing PR, must emit
    //    the terminal event with a coded status, not throw an opaque 500.
    let result: Awaited<ReturnType<typeof vcs.approveWorkflowRuns>>;
    try {
      result = await vcs.approveWorkflowRuns({ owner, repo, prNumber });
    } catch (error) {
      const g = classifyGithubOpError(error);
      return fail(g.status, g.errorCode, g.error, { prNumber });
    }

    // 5b. Build the deployable image (the BUILD half of run-ci — "the build is
    //     100% critical to CI"). A fork PR's `pull_request` run is read-only and
    //     cannot push, so the approved gate CI alone yields no flightable image.
    //     The operator dispatches the SAME pr-build.yml (workflow_dispatch, trusted
    //     base-repo context) for the approved head → `sha-<headSha>`, which
    //     candidate-flight then resolves. No new workflow; RBAC was the gate above.
    if (result.headRepo && result.headSha) {
      try {
        await deployPlane.dispatchPrBuild({
          owner,
          repo,
          headRepo: result.headRepo,
          headSha: result.headSha,
          prNumber,
        });
      } catch (error) {
        const g = classifyGithubOpError(error);
        return fail(g.status, g.errorCode, g.error, {
          prNumber,
          slug: rbac.node.slug,
        });
      }
    }

    // 6. Success.
    logEvent(
      ctx.log,
      EVENT_NAMES.VCS_RUN_CI_REQUEST_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "success",
        status: 200,
        prNumber,
        slug: rbac.node.slug,
        approved: result.approved,
        headSha8: result.headSha?.slice(0, 8),
        durationMs: durationMs(),
      },
      EVENT_NAMES.VCS_RUN_CI_REQUEST_COMPLETE
    );

    return NextResponse.json(runCiOperation.output.parse(result), {
      status: 200,
    });
  }
);
