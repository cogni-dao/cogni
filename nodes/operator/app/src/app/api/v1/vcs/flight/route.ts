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

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { flightOperation } from "@cogni/node-contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
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
  readonly nodeId?: string | undefined;
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

function logGithubAdapterError(
  ctx: RequestContext,
  startedAt: number,
  fields: {
    readonly operation: string;
    readonly reasonCode: string;
    readonly status?: number | undefined;
    readonly nodeId?: string | undefined;
    readonly slug?: string | undefined;
    readonly prNumber?: number | undefined;
  }
): void {
  ctx.log.error(
    {
      event: EVENT_NAMES.ADAPTER_GITHUB_REPO_WRITE_ERROR,
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      dep: "github",
      durationMs: elapsedMs(startedAt),
      ...fields,
    },
    EVENT_NAMES.ADAPTER_GITHUB_REPO_WRITE_ERROR
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
  readonly sessionUser: {
    readonly id: string;
    readonly displayName?: string | null;
  };
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
    return params.node.ownerUserId === params.sessionUser.id
      ? { ok: true }
      : { ok: false, status: 404, errorCode: "node_not_found" };
  }

  const db = resolveServiceDb();
  const billingAccountRows = await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.ownerUserId, params.sessionUser.id))
    .limit(1);
  const billingAccount = billingAccountRows[0];
  if (!billingAccount) {
    return { ok: false, status: 403, errorCode: "billing_account_missing" };
  }

  const decision = await authorization.check({
    actorId: `user:${params.sessionUser.id}`,
    action: "node.flight",
    resource: `node:${params.node.id}`,
    context: {
      tenantId: billingAccount.id,
      nodeId: params.node.id,
    },
  });

  if (decision.decision === "allow") return { ok: true };
  return {
    ok: false,
    status: decision.code === "authz_unavailable" ? 503 : 403,
    errorCode: decision.code,
  };
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
  { routeId: "vcs.flight", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let terminalLogged = false;
    const logTerminal = (fields: FlightLogFields): void => {
      terminalLogged = true;
      logFlightRequestComplete(ctx, startedAt, fields);
    };
    try {
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

      const { nodeRef } = parsed.data;
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
        .where(eq(nodes.id, nodeRef.nodeId))
        .limit(1);
      const node = rows[0];
      if (!node) {
        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status: 404,
          errorCode: "node_not_found",
          nodeId: nodeRef.nodeId,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }

      const authz = await authorizeNodeFlight({ sessionUser, node });
      if (!authz.ok) {
        logTerminal({
          mode,
          outcome: "error",
          status: authz.status,
          errorCode: authz.errorCode,
          nodeId: nodeRef.nodeId,
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
          nodeId: nodeRef?.nodeId,
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
          nodeId: nodeRef.nodeId,
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
        logGithubAdapterError(ctx, startedAt, {
          operation: "prepare_node_ref_candidate_flight",
          reasonCode: errorCode,
          status: githubStatus(error),
          nodeId: nodeRef.nodeId,
          slug: node.slug,
        });
        if (response) {
          logTerminal({
            mode: "node_ref",
            outcome: "error",
            status: response.status,
            errorCode,
            githubStatus: githubStatus(error),
            nodeId: nodeRef.nodeId,
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
          nodeId: nodeRef.nodeId,
          slug: node.slug,
          sourceSha8: nodeRef.sourceSha.slice(0, 8),
        });
        throw error;
      }

      // vnext: this records dispatch acceptance only. Workflow started/completed/failed
      // needs a GitHub Actions webhook or polling listener before those states are observable.
      try {
        const dispatch = await deployPlane.dispatchNodeRefCandidateFlight({
          owner: parentRepo.owner,
          repo: parentRepo.repo,
          slug: prepared.slug,
          sourceSha: prepared.sourceSha,
        });

        logTerminal({
          mode: "node_ref",
          outcome: "success",
          status: 202,
          nodeId: prepared.nodeId,
          slug: prepared.slug,
          sourceSha8: prepared.sourceSha.slice(0, 8),
          dispatchStatus: "initiated",
        });
        return NextResponse.json(
          flightOperation.output.parse({
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
          }),
          { status: 202 }
        );
      } catch (error) {
        const dispatchError = dispatchErrorResponse(error);
        const errorCode =
          dispatchError?.errorCode ?? "node_ref_dispatch_failed";
        logGithubAdapterError(ctx, startedAt, {
          operation: "dispatch_node_ref_candidate_flight",
          reasonCode: errorCode,
          status: githubStatus(error),
          nodeId: prepared.nodeId,
          slug: prepared.slug,
        });
        logTerminal({
          mode: "node_ref",
          outcome: "error",
          status: dispatchError?.response.status ?? 500,
          errorCode,
          githubStatus: githubStatus(error),
          nodeId: prepared.nodeId,
          slug: prepared.slug,
          sourceSha8: prepared.sourceSha.slice(0, 8),
        });
        if (dispatchError) return dispatchError.response;
        throw error;
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
      throw error;
    }
  }
);
