// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/flight`
 * Purpose: Source-addressed candidate-a flight request for external AI agents.
 *   Two flight shapes, both dispatching `candidate-flight.yml` on the operator parent repo:
 *     - `nodeRef`: externally built child-node artifact rows (slug + sourceSha).
 *     - `codePr`:  an operator-MONOREPO PR by `prNumber` — the code-PR path that lets an external
 *       agent (read-only on GitHub, API-key only) flight its OWN monorepo PR without a maintainer
 *       `gh workflow run`. The operator GitHub App dispatches the workflow on the agent's behalf.
 *   The candidate slot controller (GitHub Actions workflow) owns the actual slot lease
 *   on the deploy branch — this endpoint does not replicate that logic.
 * Scope: Auth → RBAC/artifact gate → dispatch. No lease table. No polling hacks. Adds NO
 *   deploy-brain / script / workflow logic — reuses the existing candidate-flight dispatch
 *   (freeze-policy compliant).
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session. No open access.
 *   - ARTIFACT_GATE: nodeRef rejects before dispatch if the requested image tag is absent.
 *   - OPERATOR_DEPLOY_PLANE: Hosted flight dispatch goes through an operator-local port.
 *   - NODE_REF_CANDIDATE_ONLY: nodeRef dispatch targets candidate-a only; preview/prod promotion carries the resolved digest.
 *   - CODE_PR_AUTHORITY_IS_OPERATOR_NODE: the `codePr` path is authorized through the shared
 *     `resolveNodeAndAuthorize` seam against the OPERATOR node (slug `operator`), reusing `can_flight`
 *     — flighting the monorepo is a repo-level operator authority, NOT an arbitrary agent-supplied
 *     node (mirrors the merge route). Fails closed (503) when no authority is configured.
 *   - NO_REPO_FROM_AGENT: for `codePr`, owner/repo are env-resolved (operator's own monorepo),
 *     never the request body (anti-spoof) — same as the merge route.
 *   - CONTRACTS_ARE_TRUTH: Input/output parsed through flightOperation contract.
 *   - NO_LEASE_SPLIT_BRAIN: Slot lease lives on the deploy branch (candidate-slot-controller);
 *     this route does not write a competing lease.
 *   - FORK_PR_IMAGE_COUPLING: for a FORK monorepo PR the `pr-{N}-{sha}` image only exists AFTER the
 *     operator-approved fork build (separate work — `fork-build`). This route flights whatever image
 *     candidate-flight resolves for that PR; it does not build the image.
 * Side-effects: IO (DB read, GitHub REST API via OperatorDeployPlanePort)
 * Links: task.0370, packages/node-contracts/src/vcs.flight.v1.contract.ts,
 *   nodes/operator/app/src/app/_lib/node-rbac.ts, docs/spec/development-lifecycle.md
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { flightOperation } from "@cogni/node-contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import type {
  OperatorDeployPlanePort,
  PreparedNodeRefCandidateFlight,
} from "@/ports";
import { nodes } from "@/shared/db/nodes";
import { type ServerEnv, serverEnv } from "@/shared/env";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";

/** Flighting the monorepo is the operator node's authority — gate on it, not the body. */
const OPERATOR_NODE_SLUG = "operator";

type FlightMode = "node_ref" | "code_pr" | "unknown";
type FlightOutcome = "success" | "error";

interface FlightLogFields {
  readonly mode: FlightMode;
  readonly outcome: FlightOutcome;
  readonly status: number;
  readonly errorCode?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly slug?: string | undefined;
  readonly sourceSha8?: string | undefined;
  readonly prNumber?: number | undefined;
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

/**
 * The operator's own parent monorepo — env-resolved, never from the agent (anti-spoof). Both flight
 * shapes dispatch candidate-flight.yml here: nodeRef carries node_slug/source_sha, codePr carries
 * pr_number.
 */
function getFlightParentRepo(env: ServerEnv): {
  readonly owner: string;
  readonly repo: string;
} {
  if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
    throw new Error(
      "operator not configured for flight: NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO required"
    );
  }
  return {
    owner: env.NODE_SUBMODULE_PARENT_OWNER,
    repo: env.NODE_SUBMODULE_PARENT_REPO,
  };
}

/**
 * Code-PR flight: dispatch candidate-flight.yml for an operator-MONOREPO PR by `pr_number`. Mirrors
 * the merge route — RBAC on the OPERATOR node's `can_flight` via the ONE node-authz seam, env-resolved
 * repo (anti-spoof), then the existing candidate-flight dispatch via the operator deploy plane. Returns
 * a coded 202 like the nodeRef path.
 */
async function handleCodePrFlight(params: {
  readonly ctx: RequestContext;
  readonly startedAt: number;
  readonly logTerminal: (fields: FlightLogFields) => void;
  readonly sessionUser: { readonly id: string };
  readonly prNumber: number;
}): Promise<NextResponse> {
  const { ctx, startedAt, logTerminal, sessionUser, prNumber } = params;
  const mode: FlightMode = "code_pr";

  // RBAC — the ONE node-authz seam, against the operator node, reusing can_flight.
  // Fails closed (503) when no authority is configured (CODE_PR_AUTHORITY_IS_OPERATOR_NODE).
  const rbac = await resolveNodeAndAuthorize({
    id: OPERATOR_NODE_SLUG,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!rbac.ok) {
    logTerminal({
      mode,
      outcome: "error",
      status: rbac.status,
      errorCode: rbac.errorCode,
      prNumber,
    });
    return NextResponse.json(
      {
        error:
          rbac.errorCode === "authz_unavailable"
            ? "authorization unavailable"
            : rbac.errorCode === "node_not_found"
              ? "operator node not found"
              : "not authorized",
        errorCode: rbac.errorCode,
      },
      { status: rbac.status }
    );
  }

  const env = serverEnv();

  let deployPlane: OperatorDeployPlanePort;
  try {
    deployPlane = createOperatorDeployPlane(env);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "deploy plane not configured";
    logTerminal({
      mode,
      outcome: "error",
      status: 503,
      errorCode: "deploy_plane_config_missing",
      prNumber,
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }

  let parentRepo: ReturnType<typeof getFlightParentRepo>;
  try {
    parentRepo = getFlightParentRepo(env);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "flight parent repo not configured";
    logTerminal({
      mode,
      outcome: "error",
      status: 503,
      errorCode: "flight_parent_config_missing",
      prNumber,
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }

  // vnext: this records dispatch acceptance only — workflow started/completed/failed needs a
  // GitHub Actions webhook or polling listener before those states are observable.
  try {
    const dispatch = await deployPlane.dispatchCodePrCandidateFlight({
      owner: parentRepo.owner,
      repo: parentRepo.repo,
      prNumber,
    });
    logTerminal({
      mode,
      outcome: "success",
      status: 202,
      prNumber,
      dispatchStatus: "initiated",
    });
    return NextResponse.json(
      flightOperation.output.parse({
        dispatched: dispatch.dispatched,
        slot: "candidate-a",
        codePr: { prNumber },
        workflowUrl: dispatch.workflowUrl,
        message: dispatch.message,
      }),
      { status: 202 }
    );
  } catch (error) {
    const dispatchError = dispatchErrorResponse(error);
    const errorCode = dispatchError?.errorCode ?? "code_pr_dispatch_failed";
    logGithubAdapterError(ctx, startedAt, {
      operation: "dispatch_code_pr_candidate_flight",
      reasonCode: errorCode,
      status: githubStatus(error),
      prNumber,
    });
    logTerminal({
      mode,
      outcome: "error",
      status: dispatchError?.response.status ?? 500,
      errorCode,
      githubStatus: githubStatus(error),
      prNumber,
    });
    if (dispatchError) return dispatchError.response;
    throw error;
  }
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

      // codePr — operator-MONOREPO PR flight. RBAC on the operator node's can_flight, then
      // dispatch candidate-flight.yml with pr_number (NO_REPO_FROM_AGENT: env-resolved repo).
      if ("codePr" in parsed.data) {
        return await handleCodePrFlight({
          ctx,
          startedAt,
          logTerminal,
          sessionUser,
          prNumber: parsed.data.codePr.prNumber,
        });
      }

      const { nodeRef } = parsed.data;
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
          nodeId: nodeRef?.nodeId,
        });
        return NextResponse.json({ error: message }, { status: 503 });
      }

      let parentRepo: ReturnType<typeof getFlightParentRepo>;
      try {
        parentRepo = getFlightParentRepo(env);
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
