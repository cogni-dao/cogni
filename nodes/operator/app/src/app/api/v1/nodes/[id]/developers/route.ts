// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/developers`
 * Purpose: Owner-gated approval surface for node access roles (the grant half of the request→approve workflow).
 * Scope: Browser-session owners approve/reject a registered agent for one node by writing/removing the
 *   requested OpenFGA role tuple — `developer` (→can_flight) or `production_promoter` (→can_promote_production).
 *   `role` defaults to `developer`. A `developer` decision ALSO provisions/de-provisions GitHub
 *   branch-push on the node repo via the operator App (rbac.md §6a) — best-effort, never reversing the
 *   authoritative tuple write. Without a grant path the role relations are inert (rbac.md §6).
 * Invariants: OWNER_GATING, OPENFGA_IS_AUTHORITY, NO_LOCAL_ROLE_TABLE, ROLE_FROM_NODE_ACCESS_ROLES,
 *   TRUST_BOUNDARY_IS_MERGE_NOT_PUSH, PUSH_LOGIN_FROM_REQUEST (no githubLogin param — from the request row).
 * Side-effects: IO (Postgres read, OpenFGA tuple write/delete, GitHub repo collaborator add/remove via App)
 * Links: docs/spec/rbac.md (§6, §6a), docs/spec/identity-model.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import {
  getContainer,
  resolveAppDb,
  resolveServiceDb,
} from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  getRequestedGithubLogin,
  transitionAccessRequestOnDecision,
} from "@/features/nodes/access-requests";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { getServerSessionUser } from "@/lib/auth/server";
import { NODE_ACCESS_ROLES } from "@/shared/db/node-access-requests";
import { nodes } from "@/shared/db/nodes";
import { userBindings } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeveloperDecisionInput = z.object({
  agentUserId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  role: z.enum(NODE_ACCESS_ROLES).default("developer"),
  // NO githubLogin here by design (rbac.md §6a): the human approving never supplies a GitHub login.
  // The agent declared its own login on the access REQUEST; approve resolves it from there.
});

/** Outcome of the §6a GitHub branch-push side-effect, surfaced in the response + audit log. */
type BranchPushOutcome =
  | "granted"
  | "invited"
  | "revoked"
  | "skipped:not_developer_role"
  | "skipped:github_identity_unbound"
  | "error";

type DeveloperDecision = z.infer<typeof DeveloperDecisionInput>["decision"];

interface DeveloperDecisionLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly decision?: DeveloperDecision | undefined;
  readonly agentUserId?: string | undefined;
  readonly role?: string | undefined;
  readonly branchPush?: BranchPushOutcome | undefined;
  readonly errorCode?: string | undefined;
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logDeveloperDecisionComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: DeveloperDecisionLogFields
): void {
  const payload = {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: elapsedMs(startedAt),
    ...fields,
  };
  if (fields.outcome === "success") {
    logEvent(
      ctx.log,
      EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE,
      payload,
      EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE
    );
    return;
  }
  const level = fields.status >= 500 ? "error" : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE, ...payload },
    EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE
  );
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.developers",
    auth: { mode: "optional", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, session, routeCtx) => {
    const startedAt = performance.now();
    const { id } = await (routeCtx?.params ??
      Promise.resolve({ id: "unknown" }));
    const logTerminal = (fields: DeveloperDecisionLogFields): void =>
      logDeveloperDecisionComplete(ctx, startedAt, fields);

    if (!session) {
      logTerminal({
        outcome: "error",
        status: 401,
        nodeId: id,
        errorCode: "unauthorized",
      });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        errorCode: "invalid_json",
      });
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    const parsed = DeveloperDecisionInput.safeParse(body);
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        errorCode: "validation_error",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = resolveAppDb();
    const existing = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) =>
        tx
          .select({ id: nodes.id, slug: nodes.slug })
          .from(nodes)
          .where(and(nodeIdOrSlug(id), eq(nodes.ownerUserId, session.id)))
          .limit(1)
    );
    const ownerNode = existing[0];
    if (!ownerNode) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // The path `{id}` may be a slug; the OpenFGA resource + tracking FK must use the canonical
    // node identity (`nodes.id` == repo-spec node_id), never the raw addressing segment.
    const nodeRowId = ownerNode.id;

    const serviceDb = resolveServiceDb();
    const agentUsers = await serviceDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, parsed.data.agentUserId))
      .limit(1);
    if (!agentUsers[0]) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "agent_user_not_found",
      });
      return NextResponse.json(
        { error: "agent user not found" },
        { status: 404 }
      );
    }

    const authorization = getContainer().authorization;
    if (!authorization) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "authz_unavailable",
      });
      return NextResponse.json(
        {
          error: "authorization not configured",
          errorCode: "authz_unavailable",
        },
        { status: 503 }
      );
    }

    const tuple = {
      user: `user:${parsed.data.agentUserId}`,
      relation: parsed.data.role,
      object: `node:${nodeRowId}`,
    };
    const write =
      parsed.data.decision === "approve"
        ? await authorization.writeRelation(tuple)
        : await authorization.deleteRelation(tuple);

    if (write.decision !== "success") {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: write.code,
      });
      return NextResponse.json(
        {
          error: "authorization write unavailable",
          errorCode: write.code,
        },
        { status: 503 }
      );
    }

    // rbac.md §6a — provision/de-provision GitHub branch-push as a side-effect of the developer
    // grant (the OpenFGA tuple above is the flight authority; branch-push is the contributor golden
    // path). Best-effort: branch-push failure never reverses the authoritative tuple write — the agent
    // still holds `can_flight` and the fork-PR fallback. Resolve the login from the agent's `github`
    // binding, else the owner-attested `githubLogin` (V0); never guess a login.
    let branchPush: BranchPushOutcome =
      parsed.data.role === "developer"
        ? "skipped:github_identity_unbound"
        : "skipped:not_developer_role";
    if (parsed.data.role === "developer") {
      // Resolve the agent's GitHub login: the login it declared on its own access REQUEST (primary,
      // rbac.md §6a — the human supplies nothing), else its linked `github` user_binding (fallback).
      const requestedLogin = await getRequestedGithubLogin(serviceDb, {
        nodeId: nodeRowId,
        agentUserId: parsed.data.agentUserId,
        role: parsed.data.role,
      });
      const [binding] = await serviceDb
        .select({ login: userBindings.providerLogin })
        .from(userBindings)
        .where(
          and(
            eq(userBindings.userId, parsed.data.agentUserId),
            eq(userBindings.provider, "github")
          )
        )
        .limit(1);
      const login = requestedLogin ?? binding?.login ?? null;
      if (!login && parsed.data.decision === "reject") {
        // De-provisioning needs a login. An owner-attested grant (no `github` binding) can't be
        // auto-revoked here unless the reject re-supplies `githubLogin` — surface it loudly so push
        // access is never SILENTLY orphaned (V0 limitation, rbac.md §6a; the durable fix is
        // binding-based, where the login is always resolvable on revoke).
        ctx.log.warn(
          {
            event: EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            nodeId: id,
            agentUserId: parsed.data.agentUserId,
            errorCode: "branch_push_deprovision_skipped",
          },
          "branch_push_deprovision_skipped"
        );
      } else if (login) {
        try {
          const env = serverEnv();
          const deployPlane = createOperatorDeployPlane(env);
          // Target the node's OWN repo (catalog `source_repo` via resolveNodeRepo), NOT
          // `nodes.repoOwner/repoName` (which holds the submodule-PARENT monorepo). Same resolution
          // the merge/run-ci routes use. `catalog_missing` (the operator node IS the monorepo) → the
          // parent repo is the target. Without a configured parent there is no repo to grant on.
          let owner = env.NODE_SUBMODULE_PARENT_OWNER;
          let repo = env.NODE_SUBMODULE_PARENT_REPO;
          try {
            const nodeRepo = await deployPlane.resolveNodeRepo({
              parentOwner: owner ?? "",
              parentRepo: repo ?? "",
              slug: ownerNode.slug,
            });
            owner = nodeRepo.owner;
            repo = nodeRepo.repo;
          } catch (error) {
            if ((error as { code?: string })?.code !== "catalog_missing")
              throw error;
            // catalog_missing ⇒ keep the parent monorepo (operator-node lane).
          }
          if (!owner || !repo) {
            throw new Error(
              "node repo not resolvable (no catalog row, no parent configured)"
            );
          }
          if (parsed.data.decision === "approve") {
            const r = await deployPlane.setNodeCollaborator({
              owner,
              repo,
              login,
              permission: "push",
            });
            branchPush = r.invitationId ? "invited" : "granted";
          } else {
            await deployPlane.removeNodeCollaborator({ owner, repo, login });
            branchPush = "revoked";
          }
        } catch (error) {
          branchPush = "error";
          // Stable failure-class signal: the GitHub HTTP status distinguishes 404 (App not installed
          // on the resolved repo) from 403 (App lacks admin) from other — the field that pinpointed
          // the wrong-repo bug. `err` is a controlled GitHub API message (no secrets/user content).
          const githubStatus =
            error &&
            typeof error === "object" &&
            "status" in error &&
            typeof (error as { status: unknown }).status === "number"
              ? (error as { status: number }).status
              : undefined;
          ctx.log.warn(
            {
              event: EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE,
              reqId: ctx.reqId,
              routeId: ctx.routeId,
              nodeId: id,
              agentUserId: parsed.data.agentUserId,
              errorCode: "branch_push_provision_failed",
              githubStatus,
              err: error instanceof Error ? error.message : String(error),
            },
            "branch_push_provision_failed"
          );
        }
      }
    }

    // Reflect the decision into the tracking row when the agent filed one. Best-effort UX state:
    // the tuple write above is the authority, so a tracking-row failure must not fail the decision
    // (a missing row is already a no-op). Log and continue.
    try {
      await transitionAccessRequestOnDecision(serviceDb, {
        nodeId: nodeRowId,
        agentUserId: parsed.data.agentUserId,
        role: parsed.data.role,
        decision: parsed.data.decision,
      });
    } catch (error) {
      ctx.log.warn(
        {
          event: EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: id,
          agentUserId: parsed.data.agentUserId,
          errorCode: "access_request_transition_failed",
          err: error instanceof Error ? error.message : String(error),
        },
        "node_access_request_transition_failed"
      );
    }

    logTerminal({
      outcome: "success",
      status: 200,
      nodeId: id,
      decision: parsed.data.decision,
      agentUserId: parsed.data.agentUserId,
      role: parsed.data.role,
      branchPush,
    });
    return NextResponse.json({
      nodeId: nodeRowId,
      agentUserId: parsed.data.agentUserId,
      decision: parsed.data.decision,
      role: parsed.data.role,
      branchPush,
    });
  }
);
