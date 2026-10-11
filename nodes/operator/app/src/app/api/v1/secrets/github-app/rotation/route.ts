// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/secrets/github-app/rotation`
 * Purpose: Typed OperatorSecretsPlane rotation verb for the platform-owned
 *   GitHub App credential pair (subtask.5016). The caller supplies ONLY the
 *   staged pair; the server owns every coordinate (env, OpenBao path, expected
 *   App identity, installation owner, webhook host). Validates against live
 *   GitHub, then ONE atomic KV-v2 pair write with check-and-set (C4), then an
 *   honest propagation verdict (C2). This is the sanctioned operator-API entry
 *   point (secrets-management.md Invariant 9); the subtask.5017 OIDC workflow is
 *   its thin caller.
 * Scope: auth → OpenFGA gate on the OPERATOR node (server-pinned, never caller
 *   input) → facade. No GitHub mutation — key mint is FIRST and revocation LAST,
 *   both human ceremony steps (C1).
 * Invariants:
 *   - AUTH_REQUIRED + OPENFGA_FAIL_CLOSED: `node.manage_secrets` on `operator`;
 *     undefined authz → 503, not-allow → 403 (mirrors the self-serve route).
 *   - SERVER_PINNED_RESOURCE: the node id handed to RBAC is the literal
 *     `operator` — a caller cannot retarget the gate or the OpenBao bucket.
 *   - NO_SECRETS_IN_LOG: the staged key crosses only the request body; the log
 *     line + response carry conclusion, fingerprints, versions, reasons.
 *   - HONOR_OR_REFUSE: invalid/misbound/unconfigured/failed never report
 *     success and never touch custody; `rotated` is only emitted when the live
 *     consumer already demonstrably holds the staged key.
 * Side-effects: IO (OpenBao read/write, read-only GitHub probes).
 * Links: src/features/secrets/app-credential-rotation.service.ts,
 *   docs/spec/cicd-platform-boundary.md (OperatorSecretsPlanePort row),
 *   docs/spec/secrets-management.md (Invariant 9), subtask.5016
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorAppCredentialsPlane } from "@/bootstrap/capabilities/operator-app-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  type AppCredentialPlaneDeps,
  type AppCredentialReport,
  DeployEnvUnsetError,
  rotateOperatorAppCredential,
} from "@/features/secrets/app-credential-rotation.service";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ONE node whose credential pair this verb rotates — never caller input. */
const OPERATOR_NODE_ID = "operator";

// `strictObject`: an unrecognized field is a 400, never a silent drop (the
// version-skew-security lesson from the self-serve route). The staged pair is
// the entire caller surface — everything else is server-owned policy.
const RotationInput = z.strictObject({
  appId: z.string().regex(/^\d+$/, "appId must be the numeric GitHub App id"),
  privateKeyBase64: z.string().min(1),
});

/** Conclusions that mean "the plane worked" (HTTP 200) vs refusals. */
const CONCLUSION_STATUS: Record<AppCredentialReport["conclusion"], number> = {
  current: 200,
  rotated: 200,
  written_not_propagated: 200,
  unconfigured: 503,
  invalid: 422,
  misbound: 422,
  failed: 502,
};

interface RotationLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly conclusion?: string | undefined;
  readonly reasons?: readonly string[] | undefined;
  readonly stagedKeyFingerprint?: string | null | undefined;
  readonly storedKeyFingerprint?: string | undefined;
  readonly liveKeyFingerprint?: string | undefined;
  readonly kvVersion?: number | undefined;
  readonly env?: string | undefined;
  readonly errorCode?: string | undefined;
}

function logRotationComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: RotationLogFields
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
    {
      event: EVENT_NAMES.OPERATOR_APP_CREDENTIAL_ROTATION_COMPLETE,
      ...payload,
    },
    EVENT_NAMES.OPERATOR_APP_CREDENTIAL_ROTATION_COMPLETE
  );
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "secrets.github-app.rotation",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const logTerminal = (fields: RotationLogFields): void =>
      logRotationComplete(ctx, startedAt, fields);

    const parsed = RotationInput.safeParse(await request.json());
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: OPERATOR_NODE_ID,
        errorCode: "validation_error",
      });
      return NextResponse.json({ error: "invalid input" }, { status: 400 });
    }

    const gate = await resolveNodeAndAuthorize({
      id: OPERATOR_NODE_ID,
      userId: sessionUser.id,
      action: "node.manage_secrets",
    });
    if (!gate.ok) {
      logTerminal({
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
      logTerminal({
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
      reportBody = await rotateOperatorAppCredential(plane, parsed.data);
    } catch (error) {
      if (error instanceof DeployEnvUnsetError) {
        logTerminal({
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
      logTerminal({
        outcome: "error",
        status: 502,
        nodeId: OPERATOR_NODE_ID,
        errorCode: "rotation_failed",
      });
      return NextResponse.json(
        { error: "rotation failed", errorCode: "rotation_failed" },
        { status: 502 }
      );
    }

    const status = CONCLUSION_STATUS[reportBody.conclusion];
    logTerminal({
      outcome: status === 200 ? "success" : "error",
      status,
      nodeId: OPERATOR_NODE_ID,
      conclusion: reportBody.conclusion,
      reasons: reportBody.reasons,
      stagedKeyFingerprint: reportBody.staged?.keyFingerprint,
      storedKeyFingerprint: reportBody.stored?.keyFingerprint,
      liveKeyFingerprint: reportBody.liveConsumer?.keyFingerprint,
      kvVersion: reportBody.kvVersion,
      env: reportBody.env,
    });
    return NextResponse.json(reportBody, { status });
  }
);
