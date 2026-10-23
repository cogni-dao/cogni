// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/flight`
 * Purpose: Source-addressed candidate-a flight request for external AI agents.
 *   Supports node-ref flights for externally built artifact rows.
 *   The candidate slot controller (GitHub Actions workflow) owns the actual slot lease
 *   on the deploy branch — this endpoint does not replicate that logic.
 * Scope: Auth → artifact gate → dispatch. No lease table. No polling hacks.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session. No open access.
 *   - EXPLICIT_CALLER_AUTHORITY: This direct API is the authenticated, explicitly requested flight
 *     path. AI tool callers separately require getCiStatus.allGreen before invoking it.
 *   - INDEPENDENT_WORKFLOW_AUTHORITY: remote overrides require target and operator flight grants;
 *     the child source stays independent of reviewed parent workflow code.
 *   - ARTIFACT_GATE: Rejects before dispatch if the requested image tag is absent.
 *   - OPERATOR_DEPLOY_PLANE: Hosted flight dispatch goes through an operator-local port.
 *   - NODE_REF_CANDIDATE_ONLY: nodeRef dispatch targets candidate-a only; preview/prod promotion carries the resolved digest.
 *   - CONTRACTS_ARE_TRUTH: Input/output parsed through flightOperation contract.
 *   - NO_LEASE_SPLIT_BRAIN: Slot lease lives on the deploy branch (candidate-slot-controller);
 *     this route does not write a competing lease.
 * Side-effects: IO (DB read, GitHub REST API via DeployPlanePort)
 * Links: task.0370, packages/node-contracts/src/vcs.flight.v1.contract.ts,
 *   docs/spec/development-lifecycle.md
 * @public
 */

import {
  type AuthzDecisionCode,
  authzUserResource,
} from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { flightOperation, type RequestPrincipal } from "@cogni/node-contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import type { DeployPlanePort, PreparedNodeRefCandidateFlight } from "@/ports";
import { nodes } from "@/shared/db/nodes";
import { type ServerEnv, serverEnv } from "@/shared/env";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";

type FlightMode = "node_ref" | "unknown";
type FlightOutcome = "success" | "error";

interface FlightLogFields {
  readonly mode: FlightMode;
  readonly outcome: FlightOutcome;
  readonly status: number;
  readonly errorCode?: string | undefined;
  readonly targetNodeId?: string | undefined;
  readonly slug?: string | undefined;
  readonly sourceSha8?: string | undefined;
  readonly githubStatus?: number | undefined;
  readonly dispatchStatus?: "initiated" | undefined;
}

type FlightAuthzErrorCode = Extract<
  AuthzDecisionCode,
  "authz_denied" | "authz_unavailable"
>;

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logFlightRequestComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: FlightLogFields
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
      EVENT_NAMES.VCS_FLIGHT_REQUEST_COMPLETE,
      payload,
      EVENT_NAMES.VCS_FLIGHT_REQUEST_COMPLETE
    );
    return;
  }
  const level = fields.status >= 500 ? "error" : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.VCS_FLIGHT_REQUEST_COMPLETE, ...payload },
    EVENT_NAMES.VCS_FLIGHT_REQUEST_COMPLETE
  );
}

function githubStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function dispatchErrorResponse(
  error: unknown
): { readonly response: NextResponse; readonly errorCode: string } | null {
  if (githubStatus(error) === 404) {
    return {
      response: NextResponse.json(
        { error: "candidate-flight.yml workflow not found on this repo" },
        { status: 503 }
      ),
      errorCode: "workflow_not_found",
    };
  }
  return null;
}

function handleDeployPlaneError(error: unknown): NextResponse | null {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const err = error as { status: number; code?: string; message?: string };
    return NextResponse.json(
      {
        error: err.message ?? "node-ref flight preflight failed",
        errorCode: err.code ?? "deploy_plane_error",
      },
      { status: err.status }
    );
  }
  return null;
}

async function authorizeNodeFlight(params: {
  readonly principal: RequestPrincipal;
  readonly node: { readonly id: string; readonly ownerUserId: string };
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly errorCode:
        | FlightAuthzErrorCode
        | "node_not_found"
        | "billing_account_missing";
    }
> {
  const container = getContainer();
  const authorization = container.authorization;

  if (!authorization) {
    const compatibilityUserId =
      params.principal.kind === "human"
        ? params.principal.userId
        : params.principal.kind === "legacy_agent"
          ? params.principal.legacyUserId
          : null;
    return compatibilityUserId === params.node.ownerUserId
      ? { ok: true }
      : { ok: false, status: 404, errorCode: "node_not_found" };
  }

  const compatibilityUserId =
    params.principal.kind === "human"
      ? params.principal.userId
      : params.principal.kind === "legacy_agent"
        ? params.principal.legacyUserId
        : null;
  const billingAccountId =
    params.principal.kind === "agent"
      ? params.principal.billingAccountId
      : (
          await resolveServiceDb()
            .select({ id: billingAccounts.id })
            .from(billingAccounts)
            .where(eq(billingAccounts.ownerUserId, compatibilityUserId ?? ""))
            .limit(1)
        )[0]?.id;
  if (!billingAccountId) {
    return { ok: false, status: 403, errorCode: "billing_account_missing" };
  }

  // Durable agents authorize only as their stable actor principal. Human and
  // legacy-user principals dual-read during the node-qualification migration;
  // this preserves today's tuples without ever falling an agent back to a user.
  const actorIds =
    params.principal.kind === "agent"
      ? [params.principal.principalId]
      : [
          params.principal.principalId,
          authzUserResource(compatibilityUserId ?? ""),
        ];
  for (const actorId of new Set(actorIds)) {
    const decision = await authorization.check({
      actorId,
      action: "node.flight",
      resource: `node:${params.node.id}`,
      context: {
        tenantId: billingAccountId,
        nodeId: params.node.id,
      },
    });
    if (decision.decision === "allow") return { ok: true };
    if (decision.code === "authz_unavailable") {
      return { ok: false, status: 503, errorCode: decision.code };
    }
  }
  return {
    ok: false,
    status: 403,
    errorCode: "authz_denied",
  };
}

/**
 * INDEPENDENT_WORKFLOW_AUTHORITY: a reviewed-workflow override also needs
 * `node.flight` on the operator itself, decided for the same verified
 * principal. Target ownership is never a fallback here: no adapter fails
 * closed as 503.
 */
async function authorizeOperatorWorkflow(
  principal: RequestPrincipal
): Promise<Awaited<ReturnType<typeof authorizeNodeFlight>>> {
  if (!getContainer().authorization) {
    return { ok: false, status: 503, errorCode: "authz_unavailable" };
  }
  const operatorNode = (
    await resolveServiceDb()
      .select()
      .from(nodes)
      .where(nodeIdOrSlug("operator"))
      .limit(1)
  )[0];
  if (!operatorNode) {
    return { ok: false, status: 404, errorCode: "node_not_found" };
  }
  return authorizeNodeFlight({ principal, node: operatorNode });
}

function getNodeRefParentRepo(env: ServerEnv): {
  readonly owner: string;
  readonly repo: string;
} {
  if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
    throw new Error(
      "operator not configured for node-ref flight: NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO required"
    );
  }
  return {
    owner: env.NODE_SUBMODULE_PARENT_OWNER,
    repo: env.NODE_SUBMODULE_PARENT_REPO,
  };
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.flight", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    let terminalLogged = false;
    const logTerminal = (fields: FlightLogFields): void => {
      terminalLogged = true;
      logFlightRequestComplete(ctx, startedAt, fields);
    };
    try {
      let principal: RequestPrincipal | null;
      try {
        principal = await resolveRequestPrincipal();
      } catch (error) {
        if (error instanceof RequestIdentityUnavailableError) {
          logTerminal({
            mode: "unknown",
            outcome: "error",
            status: 503,
            errorCode: "authn_unavailable",
          });
          return NextResponse.json(
            {
              error: "authentication unavailable",
              errorCode: "authn_unavailable",
            },
            { status: 503 }
          );
        }
        throw error;
      }
      if (!principal) {
        logTerminal({
          mode: "unknown",
          outcome: "error",
          status: 401,
          errorCode: "invalid_token",
        });
        return NextResponse.json(
          { error: "invalid_token" },
          { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
        );
      }
      const parsed = flightOperation.input.safeParse(await request.json());
      if (!parsed.success) {
        logTerminal({
          mode: "unknown",
          outcome: "error",
          status: 400,
          errorCode: "validation_error",
        });
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }

      const { nodeRef, workflowRef, workflowSha } = parsed.data;
      if (!nodeRef) {
        logTerminal({
          mode: "unknown",
          outcome: "error",
          status: 400,
          errorCode: "validation_error",
        });
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const mode: FlightMode = "node_ref";
      const env = serverEnv();
      const db = resolveServiceDb();
      const rows = await db
        .select()
        .from(nodes)
        .where(nodeIdOrSlug(nodeRef.nodeId))
        .limit(1);
      const node = rows[0];
      if (!node) {
        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status: 404,
          errorCode: "node_not_found",
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }

      const authz = await authorizeNodeFlight({ principal, node });
      if (!authz.ok) {
        logTerminal({
          mode,
          outcome: "error",
          status: authz.status,
          errorCode: authz.errorCode,
          targetNodeId: node.id,
          slug: node.slug,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json(
          {
            error:
              authz.errorCode === "authz_unavailable"
                ? "authorization unavailable"
                : authz.errorCode === "billing_account_missing"
                  ? "billing account required"
                  : "not authorized",
            errorCode: authz.errorCode,
          },
          { status: authz.status }
        );
      }

      if (workflowSha !== undefined) {
        const operatorAuthority = await authorizeOperatorWorkflow(principal);
        if (!operatorAuthority.ok) {
          logTerminal({
            mode,
            outcome: "error",
            status: operatorAuthority.status,
            errorCode: operatorAuthority.errorCode,
            targetNodeId: node.id,
            slug: node.slug,
            sourceSha8: nodeRef.sourceSha.slice(0, 8),
          });
          return NextResponse.json(
            {
              error: "operator workflow authority required",
              errorCode: operatorAuthority.errorCode,
            },
            { status: operatorAuthority.status }
          );
        }
      }

      let deployPlane: DeployPlanePort;
      try {
        deployPlane = createOperatorDeployPlane(env);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "deploy plane not configured";
        logTerminal({
          mode,
          outcome: "error",
          status: 503,
          errorCode: "deploy_plane_config_missing",
          targetNodeId: node.id,
        });
        return NextResponse.json({ error: message }, { status: 503 });
      }

      let parentRepo: ReturnType<typeof getNodeRefParentRepo>;
      try {
        parentRepo = getNodeRefParentRepo(env);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "node-ref flight parent repo not configured";
        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status: 503,
          errorCode: "node_parent_config_missing",
          targetNodeId: node.id,
          slug: node.slug,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json({ error: message }, { status: 503 });
      }

      let prepared: PreparedNodeRefCandidateFlight;
      try {
        prepared = await deployPlane.prepareNodeRefCandidateFlight({
          parentOwner: parentRepo.owner,
          parentRepo: parentRepo.repo,
          nodeId: node.id,
          slug: node.slug,
          sourceSha: nodeRef.sourceSha,
        });
      } catch (error) {
        const response = handleDeployPlaneError(error);
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "node_ref_prepare_failed";

        if (response) {
          logTerminal({
            mode: "node_ref",
            outcome: "error",
            status: response.status,
            errorCode,
            githubStatus: githubStatus(error),
            targetNodeId: node.id,
            slug: node.slug,
            sourceSha8: nodeRef.sourceSha.slice(0, 8),
          });
          return response;
        }
        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status: 500,
          errorCode,
          githubStatus: githubStatus(error),
          targetNodeId: node.id,
          slug: node.slug,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json(
          { error: "flight_preflight_failed" },
          { status: 500 }
        );
      }

      const normalizedSourceRepo = prepared.sourceRepo
        .replace(/\/$/, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
      if (
        workflowSha !== undefined &&
        normalizedSourceRepo ===
          `https://github.com/${parentRepo.owner}/${parentRepo.repo}`.toLowerCase()
      ) {
        logTerminal({
          mode,
          outcome: "error",
          status: 422,
          errorCode: "independent_workflow_requires_remote_source",
          targetNodeId: node.id,
          slug: node.slug,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json(
          {
            error:
              "independent workflow identity requires a remote node source",
            errorCode: "independent_workflow_requires_remote_source",
          },
          { status: 422 }
        );
      }

      // vnext: this records dispatch acceptance only. Workflow started/completed/failed
      // needs a GitHub Actions webhook or polling listener before those states are observable.
      try {
        const dispatch = await deployPlane.dispatchNodeRefCandidateFlight({
          owner: parentRepo.owner,
          repo: parentRepo.repo,
          slug: prepared.slug,
          sourceSha: prepared.sourceSha,
          ...(workflowRef ? { workflowRef } : {}),
          ...(workflowSha ? { workflowSha } : {}),
        });

        const output = flightOperation.output.parse({
          dispatched: dispatch.dispatched,
          slot: "candidate-a",
          nodeRef: {
            nodeId: prepared.nodeId,
            slug: prepared.slug,
            sourceSha: prepared.sourceSha,
            sourceRepo: prepared.sourceRepo,
            image: prepared.image,
          },
          workflowUrl: dispatch.workflowUrl,
          message: dispatch.message,
        });

        logTerminal({
          mode: "node_ref",
          outcome: "success",
          status: 202,
          targetNodeId: prepared.nodeId,
          slug: prepared.slug,
          sourceSha8: prepared.sourceSha.slice(0, 8),
          dispatchStatus: "initiated",
        });
        return NextResponse.json(output, { status: 202 });
      } catch (error) {
        const dispatchError = dispatchErrorResponse(error);
        const deployPlaneError = handleDeployPlaneError(error);
        const errorCode =
          dispatchError?.errorCode ??
          (error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "node_ref_dispatch_failed");

        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status:
            dispatchError?.response.status ?? deployPlaneError?.status ?? 500,
          errorCode,
          githubStatus: githubStatus(error),
          targetNodeId: prepared.nodeId,
          slug: prepared.slug,
          sourceSha8: prepared.sourceSha.slice(0, 8),
        });
        if (dispatchError) return dispatchError.response;
        if (deployPlaneError) return deployPlaneError;
        return NextResponse.json(
          { error: "flight_dispatch_failed" },
          { status: 500 }
        );
      }
    } catch (error) {
      if (!terminalLogged) {
        logTerminal({
          mode: "unknown",
          outcome: "error",
          status: 500,
          errorCode: "unhandled",
          githubStatus: githubStatus(error),
        });
      }
      return NextResponse.json({ error: "flight_failed" }, { status: 500 });
    }
  }
);
