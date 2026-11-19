// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/push-token`
 * Purpose: Node-scoped, operator-minted push token. An agent with no GitHub account (a node's AI sandbox)
 *   gets a short-lived installation token for ONE node repo, limited to contents + pull_requests write, so it
 *   can push a branch and open a PR. The token comes from the unprivileged node AI App, never the operator
 *   App; only the operator holds either key. No per-node App, machine user or long-lived token exists.
 * Scope: Auth → RBAC (node-scoped, node.flight) → resolve repo → refuse the monorepo → mint. Adds no deploy-brain logic.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - RBAC_IS_THE_GATE: `node.flight` on the NAMED node: `developer`, the role that already means "may push branches
 *     to this node's repo" (rbac.md §6a). For an agent with a GitHub login that grant adds a collaborator; for a node AI
 *     with none, it lets the agent ask for this token. No new role.
 *   - NO_REPO_FROM_AGENT: owner/repo come from the node's catalog `source_repo`, never the body.
 *   - REMOTE_SOURCE_ONLY: an in-repo node (no `source_repo`) resolves to the operator monorepo, whose CI
 *     carries secrets; it is refused (403 `in_repo_node_unsupported`).
 *   - FIXED_PERMISSIONS: exactly PUSH_TOKEN_PERMISSIONS on exactly one repo. Without `workflows`, GitHub
 *     refuses any push that changes `.github/workflows`. Merge stays at POST /vcs/merge.
 *   - DEV_APP_NOT_OPERATOR_APP: a minted token acts as the node AI App, which has no ruleset bypass, so it
 *     never inherits the operator App's admin, workflow or merge-queue bypass.
 *   - TOKEN_NEVER_LOGGED: logs carry slug, principal, repo and expiry only. The response is `no-store`.
 *   - CONTRACTS_ARE_TRUTH: input/output parsed through `pushTokenOperation`.
 * Side-effects: IO (catalog read + GitHub installation-token mint via the App).
 * Links: packages/node-contracts/src/vcs.push-token.v1.contract.ts, nodes/operator/app/src/app/_lib/node-rbac.ts,
 *   https://node-template.cognidao.org/knowledge/node-ai-code-identity
 * @public
 */

import {
  PUSH_TOKEN_PERMISSIONS,
  pushTokenOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { createRepoPushTokenMinter } from "@/bootstrap/capabilities/vcs";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.pushToken", auth: { mode: "required", getSessionUser } },
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
          event: EVENT_NAMES.VCS_PUSH_TOKEN_REQUEST_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          status,
          errorCode,
          durationMs: durationMs(),
          ...extra,
        },
        EVENT_NAMES.VCS_PUSH_TOKEN_REQUEST_COMPLETE
      );
      return NextResponse.json({ error, errorCode }, { status });
    };

    // 1. Validate input. owner/repo are NOT accepted from the agent.
    const parsed = pushTokenOperation.input.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return fail(400, "validation_error", "Invalid request");
    }

    // 2. RBAC — node-scoped `can_flight` (`developer`): the same grant that provisions branch push for login agents.
    const rbac = await resolveNodeAndAuthorize({
      id: parsed.data.nodeId,
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
      return fail(rbac.status, rbac.errorCode, error);
    }
    const slug = rbac.node.slug;

    // 3. App credentials configured?
    const env = serverEnv();
    const minter = createRepoPushTokenMinter(env);
    if (!minter) {
      return fail(503, "vcs_not_configured", "VCS not configured", { slug });
    }

    // 4. Resolve the node's OWN repo from its catalog `source_repo` (operator-resolved, anti-spoof).
    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return fail(
        503,
        "push_target_not_configured",
        "parent repo not configured",
        { slug }
      );
    }
    let owner: string;
    let repo: string;
    try {
      const nodeRepo = await createOperatorDeployPlane(env).resolveNodeRepo({
        parentOwner,
        parentRepo,
        slug,
      });
      owner = nodeRepo.owner;
      repo = nodeRepo.repo;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "catalog_missing") {
        return fail(404, "catalog_missing", "node catalog entry not found", {
          slug,
        });
      }
      return fail(
        503,
        "push_target_not_configured",
        "node repo not resolvable",
        { slug }
      );
    }
    if (
      owner.toLowerCase() === parentOwner.toLowerCase() &&
      repo.toLowerCase() === parentRepo.toLowerCase()
    ) {
      return fail(
        403,
        "in_repo_node_unsupported",
        "in-repo nodes push through their own PR flow",
        {
          slug,
        }
      );
    }

    // 5. Mint. A repo the App is not installed on surfaces a coded status, not an opaque 500.
    let minted: { token: string; expiresAt: string };
    try {
      minted = await minter.mintRepoPushToken({ owner, repo });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // resolveInstallationId throws "GitHub App not installed ... (HTTP <status>)" for any non-OK lookup;
      // only a 404 means not installed. A 401/403/5xx (bad key, GitHub outage) is a mint failure.
      const notInstalled =
        error instanceof Error && /\(HTTP 404\)$/.test(error.message);
      if (notInstalled || status === 404) {
        return fail(
          502,
          "app_not_installed",
          "node AI App not installed on the node repo",
          {
            slug,
          }
        );
      }
      return fail(502, "mint_failed", "push token mint failed", { slug });
    }

    logEvent(
      ctx.log,
      EVENT_NAMES.VCS_PUSH_TOKEN_REQUEST_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "success",
        status: 200,
        slug,
        principalId: sessionUser.id,
        repo: `${owner}/${repo}`,
        expiresAt: minted.expiresAt,
        durationMs: durationMs(),
      },
      EVENT_NAMES.VCS_PUSH_TOKEN_REQUEST_COMPLETE
    );

    return NextResponse.json(
      pushTokenOperation.output.parse({
        ...minted,
        owner,
        repo,
        permissions: PUSH_TOKEN_PERMISSIONS,
      }),
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
);
