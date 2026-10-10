// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/authorization-credential/rotate`
 * Purpose: Prepare one node/environment authorization-facade credential rotation.
 * Scope: Human session + node.manage_secrets gate, generation, OpenBao custody write.
 * Invariants: SERVER_GENERATED; SERVED_ENV_ONLY; PREPARED_IS_NOT_COMPLETE; NO_TOKEN_OUTPUT.
 * Side-effects: OpenFGA check, cryptographic randomness, OpenBao write, audit log.
 * Links: task.5226, infra/secrets-catalog.yaml, docs/spec/rbac.md
 * @public
 */

import { randomBytes } from "node:crypto";

import { AUTHORIZATION_FACADE_TOKEN_PREFIX } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorSecretsPlane } from "@/bootstrap/capabilities/operator-secrets-plane";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { authorizationFacadeCredentialRotateOperation } from "@/contracts/authorization-facade.v1.contract";
import { serverEnv } from "@/shared/env";
import { canWriteSecretsLane } from "@/shared/secrets/secrets-lane-trust.data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN_KEY = "AUTHORIZATION_FACADE_TOKEN";
const OVERLAP_WINDOW_SECONDS = 10 * 60;

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "nodes.authorization_credential.rotate",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const parsed =
      authorizationFacadeCredentialRotateOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const requestedEnv = parsed.data.env;
    const { id } = await context.params;
    const gate = await resolveNodeAndAuthorize({
      id,
      userId: sessionUser.id,
      action: "node.manage_secrets",
    });
    if (!gate.ok) {
      ctx.log.warn(
        { nodeRef: id, errorCode: gate.errorCode, requestId: ctx.reqId },
        "authorization_facade.credential_rotation_denied"
      );
      return NextResponse.json(
        { error: gate.errorCode },
        { status: gate.status }
      );
    }

    const env = serverEnv();
    const deployEnv = env.DEPLOY_ENVIRONMENT;
    if (
      !deployEnv ||
      !canWriteSecretsLane(deployEnv, requestedEnv, env.FLEET_CONTROL_ENV) ||
      !gate.node.deployEnvs.includes(requestedEnv)
    ) {
      return NextResponse.json(
        { error: "node_not_deployed_in_served_environment" },
        { status: 409 }
      );
    }

    try {
      const plane = createOperatorSecretsPlane(env);
      const credential = `${AUTHORIZATION_FACADE_TOKEN_PREFIX}${gate.node.nodeId}_${randomBytes(32).toString("hex")}`;
      const result = await plane.writeSecret({
        nodeSlug: gate.node.slug,
        env: requestedEnv,
        key: TOKEN_KEY,
        value: credential,
        op: "rotate",
      });
      const output = {
        state: "prepared" as const,
        version: result.version,
        path: result.path,
        overlapWindowSeconds: OVERLAP_WINDOW_SECONDS,
        requiredNext: "redeploy_and_verify" as const,
      };
      ctx.log.info(
        {
          authenticatedUserId: sessionUser.id,
          nodeId: gate.node.nodeId,
          nodeSlug: gate.node.slug,
          env: requestedEnv,
          version: result.version,
          state: output.state,
          requiredNext: output.requiredNext,
          requestId: ctx.reqId,
        },
        "authorization_facade.credential_rotation_prepared"
      );
      return NextResponse.json(
        authorizationFacadeCredentialRotateOperation.output.parse(output),
        { status: 202 }
      );
    } catch {
      return NextResponse.json(
        { error: "authorization_credential_plane_unavailable" },
        { status: 503 }
      );
    }
  }
);
