// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/flight`
 * Purpose: CI-gated candidate-a flight request for external AI agents.
 *   Supports PR flights and candidate-only node-ref flights for externally built submodule nodes.
 *   The candidate slot controller (GitHub Actions workflow) owns the actual slot lease
 *   on the deploy branch — this endpoint does not replicate that logic.
 * Scope: Auth → CI gate → dispatch. No lease table. No polling hacks.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session. No open access.
 *   - CI_GATE: Rejects 422 if CI is not fully green for the PR head SHA.
 *   - OPERATOR_DEPLOY_PLANE: Hosted flight dispatch goes through an operator-local port.
 *   - NODE_REF_CANDIDATE_ONLY: nodeRef dispatch targets candidate-a only; preview/prod are out of scope.
 *   - CONTRACTS_ARE_TRUTH: Input/output parsed through flightOperation contract.
 *   - NO_LEASE_SPLIT_BRAIN: Slot lease lives on the deploy branch (candidate-slot-controller);
 *     this route does not write a competing lease.
 * Side-effects: IO (DB read, GitHub REST API via OperatorDeployPlanePort)
 * Links: task.0370, packages/node-contracts/src/vcs.flight.v1.contract.ts,
 *   docs/spec/development-lifecycle.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { flightOperation } from "@cogni/node-contracts";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import type {
  OperatorDeployCiStatus,
  OperatorDeployPlanePort,
  ValidatedNodeRefCandidateFlight,
} from "@/ports";
import { getGithubRepo } from "@/shared/config/repoSpec.server";
import { nodes } from "@/shared/db/nodes";
import { type ServerEnv, serverEnv } from "@/shared/env";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";

type FlightMode = "pr" | "node_ref" | "unknown";
type FlightOutcome = "success" | "error";

interface FlightLogFields {
  readonly mode: FlightMode;
  readonly outcome: FlightOutcome;
  readonly status: number;
  readonly errorCode?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly nodeId?: string | undefined;
  readonly slug?: string | undefined;
  readonly sourceSha8?: string | undefined;
  readonly checkCount?: number | undefined;
  readonly allGreen?: boolean | undefined;
  readonly pending?: boolean | undefined;
  readonly githubStatus?: number | undefined;
  readonly dispatchStatus?: "initiated" | undefined;
}

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

      const { prNumber, nodeRef } = parsed.data;
      const mode: FlightMode = nodeRef
        ? "node_ref"
        : prNumber
          ? "pr"
          : "unknown";
      const env = serverEnv();
      let deployPlane: OperatorDeployPlanePort;
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
          prNumber,
          nodeId: nodeRef?.nodeId,
        });
        return NextResponse.json({ error: message }, { status: 503 });
      }

      if (nodeRef) {
        const db = resolveAppDb();
        const rows = await withTenantScope(
          db,
          userActor(sessionUser.id as UserId),
          async (tx) =>
            tx
              .select()
              .from(nodes)
              .where(
                and(
                  eq(nodes.id, nodeRef.nodeId),
                  eq(nodes.ownerUserId, sessionUser.id)
                )
              )
              .limit(1)
        );
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

        let validated: ValidatedNodeRefCandidateFlight;
        try {
          validated = await deployPlane.validateNodeRefCandidateFlight({
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
              : "node_ref_validation_failed";
          logGithubAdapterError(ctx, startedAt, {
            operation: "validate_node_ref_candidate_flight",
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
            slug: validated.slug,
            sourceSha: validated.sourceSha,
          });

          logTerminal({
            mode: "node_ref",
            outcome: "success",
            status: 202,
            nodeId: validated.nodeId,
            slug: validated.slug,
            sourceSha8: validated.sourceSha.slice(0, 8),
            dispatchStatus: "initiated",
          });
          return NextResponse.json(
            flightOperation.output.parse({
              dispatched: dispatch.dispatched,
              slot: "candidate-a",
              nodeRef: {
                nodeId: validated.nodeId,
                slug: validated.slug,
                sourceSha: validated.sourceSha,
                sourceRepo: validated.sourceRepo,
                image: validated.image,
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
            nodeId: validated.nodeId,
            slug: validated.slug,
          });
          logTerminal({
            mode: "node_ref",
            outcome: "error",
            status: dispatchError?.response.status ?? 500,
            errorCode,
            githubStatus: githubStatus(error),
            nodeId: validated.nodeId,
            slug: validated.slug,
            sourceSha8: validated.sourceSha.slice(0, 8),
          });
          if (dispatchError) return dispatchError.response;
          throw error;
        }
      }

      if (!prNumber) {
        logTerminal({
          mode: "unknown",
          outcome: "error",
          status: 400,
          errorCode: "invalid_flight_target",
        });
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }

      const { owner, repo } = getGithubRepo();

      // CI gate: verify all checks are green for the exact PR head SHA
      let ciStatus: OperatorDeployCiStatus;
      try {
        ciStatus = await deployPlane.getCiStatus({ owner, repo, prNumber });
      } catch (error) {
        logGithubAdapterError(ctx, startedAt, {
          operation: "get_pr_ci_status",
          reasonCode: "ci_status_failed",
          status: githubStatus(error),
          prNumber,
        });
        logTerminal({
          mode: "pr",
          outcome: "error",
          status: 500,
          errorCode: "ci_status_failed",
          githubStatus: githubStatus(error),
          prNumber,
        });
        throw error;
      }
      if (!ciStatus.allGreen || ciStatus.pending) {
        logTerminal({
          mode: "pr",
          outcome: "error",
          status: 422,
          errorCode: "ci_not_green",
          prNumber,
          checkCount: ciStatus.checks.length,
          allGreen: ciStatus.allGreen,
          pending: ciStatus.pending,
        });
        return NextResponse.json(
          {
            error: `CI is not green for PR #${prNumber}. Resolve failing checks before requesting a flight.`,
            headSha: ciStatus.headSha,
            allGreen: ciStatus.allGreen,
            pending: ciStatus.pending,
          },
          { status: 422 }
        );
      }

      // Dispatch candidate-flight.yml — the workflow owns the slot lease.
      // vnext: add workflow lifecycle observability via Actions webhook/poller.
      try {
        const dispatch = await deployPlane.dispatchCandidateFlight({
          owner,
          repo,
          prNumber,
          headSha: ciStatus.headSha,
        });

        logTerminal({
          mode: "pr",
          outcome: "success",
          status: 202,
          prNumber,
          checkCount: ciStatus.checks.length,
          dispatchStatus: "initiated",
        });
        return NextResponse.json(
          flightOperation.output.parse({
            dispatched: dispatch.dispatched,
            slot: "candidate-a",
            prNumber,
            headSha: ciStatus.headSha,
            workflowUrl: dispatch.workflowUrl,
            message: dispatch.message,
          }),
          { status: 202 }
        );
      } catch (error) {
        const dispatchError = dispatchErrorResponse(error);
        const errorCode = dispatchError?.errorCode ?? "dispatch_failed";
        logGithubAdapterError(ctx, startedAt, {
          operation: "dispatch_candidate_flight",
          reasonCode: errorCode,
          status: githubStatus(error),
          prNumber,
        });
        logTerminal({
          mode: "pr",
          outcome: "error",
          status: dispatchError?.response.status ?? 500,
          errorCode,
          githubStatus: githubStatus(error),
          prNumber,
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
