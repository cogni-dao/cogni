// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/secrets/github-app/health`
 * Purpose: On-demand half of the recurring App-credential divergence evaluation
 *   (subtask.5016 C3): compares OpenBao custody, the live pod credential, and
 *   live GitHub validity, returning the same typed conclusion vocabulary as the
 *   rotation verb. The scheduled job (`app-credential-health`) runs the same
 *   facade on a cron so a staged-but-never-converged custody cannot sit silent
 *   between human calls — this route is how a human/agent reads it NOW.
 * Scope: Read-only everywhere: OpenBao GET, GitHub GETs, zero writes.
 * Invariants:
 *   - SAME_GATE_AS_ROTATION: `node.manage_secrets` on the server-pinned
 *     `operator` node; fingerprints are non-secret but credential-health facts
 *     stay behind the same RBAC as the verb that acts on them.
 *   - NEVER_GREEN_ON_INVALID: a stored credential GitHub rejects is `invalid`
 *     (HTTP 503 class), not a 200 with a warning buried in prose.
 * Side-effects: IO (OpenBao read, read-only GitHub probes).
 * Links: src/features/secrets/app-credential-rotation.service.ts,
 *   src/bootstrap/jobs/definitions/app-credential-health.job.ts, subtask.5016 (C3)
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorAppCredentialsPlane } from "@/bootstrap/capabilities/operator-app-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  type AppCredentialPlaneDeps,
  type AppCredentialReport,
  DeployEnvUnsetError,
  evaluateOperatorAppCredentialHealth,
} from "@/features/secrets/app-credential-rotation.service";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPERATOR_NODE_ID = "operator";

/** Healthy/propagating are 200; everything else names its failure class. */
const CONCLUSION_STATUS: Record<AppCredentialReport["conclusion"], number> = {
  current: 200,
  rotated: 200,
  written_not_propagated: 200,
  unconfigured: 503,
  invalid: 503,
  misbound: 503,
  failed: 502,
};

function logHealthComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: Record<string, unknown> & { outcome: string; status: number }
): void {
  const payload = {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: Math.round(performance.now() - startedAt),
    ...fields,
  };
  const level =
    fields.outcome === "success"
      ? "info"
      : fields.status >= 500
        ? "error"
        : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE, ...payload },
    EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE
  );
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "secrets.github-app.health",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const startedAt = performance.now();

    const gate = await resolveNodeAndAuthorize({
      id: OPERATOR_NODE_ID,
      userId: sessionUser.id,
      action: "node.manage_secrets",
    });
    if (!gate.ok) {
      logHealthComplete(ctx, startedAt, {
        outcome: "error",
        status: gate.status,
        nodeId: OPERATOR_NODE_ID,
        errorCode: gate.errorCode,
      });
      const body =
        gate.errorCode === "node_not_found"
          ? { error: "not found" }
          : gate.errorCode === "authz_unavailable"
            ? {
                error: "authorization not configured",
                errorCode: gate.errorCode,
              }
            : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(body, { status: gate.status });
    }

    let plane: AppCredentialPlaneDeps;
    const env = serverEnv();
    try {
      plane = { ...createOperatorAppCredentialsPlane(env), env };
    } catch (error) {
      logHealthComplete(ctx, startedAt, {
        outcome: "error",
        status: 503,
        nodeId: OPERATOR_NODE_ID,
        errorCode: "secrets_plane_config_missing",
      });
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "secrets plane not configured",
          errorCode: "secrets_plane_config_missing",
        },
        { status: 503 }
      );
    }

    let reportBody: AppCredentialReport;
    try {
      reportBody = await evaluateOperatorAppCredentialHealth(plane);
    } catch (error) {
      if (error instanceof DeployEnvUnsetError) {
        logHealthComplete(ctx, startedAt, {
          outcome: "error",
          status: 503,
          nodeId: OPERATOR_NODE_ID,
          errorCode: "deploy_env_unset",
        });
        return NextResponse.json(
          {
            error: "deploy environment not configured",
            errorCode: "deploy_env_unset",
          },
          { status: 503 }
        );
      }
      logHealthComplete(ctx, startedAt, {
        outcome: "error",
        status: 502,
        nodeId: OPERATOR_NODE_ID,
        errorCode: "health_evaluation_failed",
      });
      return NextResponse.json(
        {
          error: "health evaluation failed",
          errorCode: "health_evaluation_failed",
        },
        { status: 502 }
      );
    }

    const status = CONCLUSION_STATUS[reportBody.conclusion];
    logHealthComplete(ctx, startedAt, {
      outcome: status === 200 ? "success" : "error",
      status,
      nodeId: OPERATOR_NODE_ID,
      conclusion: reportBody.conclusion,
      reasons: reportBody.reasons,
      storedKeyFingerprint: reportBody.stored?.keyFingerprint,
      liveKeyFingerprint: reportBody.liveConsumer?.keyFingerprint,
      env: reportBody.env,
    });
    return NextResponse.json(reportBody, { status });
  }
);
