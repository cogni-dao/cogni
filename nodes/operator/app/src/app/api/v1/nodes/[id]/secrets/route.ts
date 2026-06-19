// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/secrets`
 * Purpose: Node-owner self-serve secret VALUE write/rotate. A `developer` on the
 *   node sets `cogni/<env>/<node>/<KEY>` through the operator pod's own OpenBao
 *   identity — caller holds only an API key. The value-write sibling of vcs/flight.
 * Scope: auth → OpenFGA gate → substrate-reserved-key guard → env match → secrets plane.
 *   Write/rotate only; key-name listing (GET) is deferred.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer (agents) or SIWE session. No open access.
 *   - OPENFGA_FAIL_CLOSED: undefined authz or `authz_unavailable` → 503; not-allow → 403.
 *     Never owner-fallback for a write this sensitive (design §Security boundary).
 *   - NAMESPACE_OWNERSHIP: a `can_manage_secrets` owner owns ALL of
 *     `cogni/<env>/<node>/*` and may add/set/rotate any key there. The boundary is
 *     OpenFGA per-node + the operator's-own-env path + OpenBao `_system`/`_shared`
 *     deny — NOT a per-key allowlist. Gate 2 only denies substrate-reserved keys.
 *   - ENV_IS_EXPLICIT_AND_VALIDATED: the caller STATES `env` (a `FLIGHT_ENVS` value,
 *     deploy/observability shape); the route 409s unless it equals this operator's
 *     own `DEPLOY_ENVIRONMENT`. The path env is still the operator's own, never an
 *     arbitrary body value — so the env axis stays closed AND a wrong-env intent is
 *     loud, not a silent stamp. Cross-env delivery = a future swappable adapter.
 *   - PATH_FROM_AUTHORIZED_RESOURCE: node slug from the registry-resolved node;
 *     env from the operator's own serverEnv (validated == the stated env).
 *   - NO_SECRETS_IN_LOG: the value never enters a log line; only key + env + KV version.
 * Side-effects: IO (node registry read, OpenBao HTTP write via OperatorSecretsPlanePort).
 * Links: docs/design/node-self-serve-secrets.md (Phase 3 Port alignment),
 *   src/app/api/v1/vcs/flight/route.ts, src/app/api/v1/nodes/[id]/observability/logs/route.ts
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorSecretsPlane } from "@/bootstrap/capabilities/operator-secrets-plane";
import { getContainer, resolveNodeRegistry } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { FLIGHT_ENVS, isFlightEnv } from "@/features/nodes/flight-status";
import type { OperatorSecretsPlanePort } from "@/ports";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { isNodeOwnedSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WriteSecretInput = z.object({
  key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "KEY must be uppercase letters, digits, underscores; start with a letter"
    ),
  value: z.string().min(1),
  op: z.enum(["set", "rotate"]).default("set"),
  // Explicit + required: the caller STATES which env they intend (a `FLIGHT_ENVS`
  // value), mirroring deploy's `dispatchNodePromote({ env })` and the observability
  // logs proxy's `?env=`. This operator then writes only its OWN env (validated
  // below) — making a wrong-env write a loud 409, never a silent stamp (the beacon
  // incident). Cross-env delivery is a future swappable adapter; today env must match.
  env: z.string(),
});

type AuthzErrorCode = Extract<
  AuthzDecisionCode,
  "authz_denied" | "authz_unavailable"
>;

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface SecretWriteLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly slug?: string | undefined;
  readonly key?: string | undefined;
  readonly op?: "set" | "rotate" | undefined;
  readonly env?: string | undefined;
  readonly version?: number | undefined;
  readonly errorCode?: string | undefined;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logSecretWriteComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: SecretWriteLogFields
): void {
  const payload = {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: elapsedMs(startedAt),
    ...fields,
  };
  if (fields.outcome === "success") {
    ctx.log.info(
      { event: EVENT_NAMES.NODE_SECRET_WRITE_COMPLETE, ...payload },
      EVENT_NAMES.NODE_SECRET_WRITE_COMPLETE
    );
    return;
  }
  const level = fields.status >= 500 ? "error" : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.NODE_SECRET_WRITE_COMPLETE, ...payload },
    EVENT_NAMES.NODE_SECRET_WRITE_COMPLETE
  );
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "nodes.secrets", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeCtx) => {
    const startedAt = performance.now();
    const { id } = await (routeCtx?.params ??
      Promise.resolve({ id: "unknown" }));
    const logTerminal = (fields: SecretWriteLogFields): void =>
      logSecretWriteComplete(ctx, startedAt, fields);

    const parsed = WriteSecretInput.safeParse(await request.json());
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        errorCode: "validation_error",
      });
      return NextResponse.json({ error: "invalid input" }, { status: 400 });
    }
    const { key, value, op, env: requestedEnv } = parsed.data;

    // Env is an explicit `FLIGHT_ENVS` value (deploy/observability shape), validated here.
    if (!isFlightEnv(requestedEnv)) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        key,
        op,
        env: requestedEnv,
        errorCode: "invalid_env",
      });
      return NextResponse.json(
        {
          error: "invalid env",
          errorCode: "invalid_env",
          message: `env must be one of ${FLIGHT_ENVS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // This operator serves exactly ONE env. Validate the stated env matches it
    // FIRST (before node lookup / authz): fail fast, and a wrong-env intent is a
    // loud 409 naming the right host — never a silent wrong-env write (the beacon
    // prod-clobber). The path env stays the operator's own; cross-env delivery is a
    // future swappable adapter. The served-env→host map is public (the guide), so
    // returning it pre-authz leaks nothing.
    const env = serverEnv();
    const deployEnv = env.DEPLOY_ENVIRONMENT;
    if (!deployEnv) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        key,
        op,
        env: requestedEnv,
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
    if (requestedEnv !== deployEnv) {
      logTerminal({
        outcome: "error",
        status: 409,
        nodeId: id,
        key,
        op,
        env: requestedEnv,
        errorCode: "wrong_operator_env",
      });
      return NextResponse.json(
        {
          error: `this operator serves env '${deployEnv}'; to write env '${requestedEnv}' call that environment's operator`,
          errorCode: "wrong_operator_env",
          servedEnv: deployEnv,
          requestedEnv,
        },
        { status: 409 }
      );
    }

    // Resolve the node ONCE via the shared registry resolver (by nodeId OR slug) —
    // the same surface the observability logs proxy uses, so this inherits the
    // published-node resolution and the "one env-aware record" invariant.
    const summaries = await resolveNodeRegistry().listPublic();
    const found = summaries.find((n) => n.nodeId === id || n.slug === id);
    if (!found?.nodeId) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        key,
        op,
        env: requestedEnv,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const node = { id: found.nodeId, slug: found.slug };

    // Gate 1 — OpenFGA. Fail-closed: no authority configured → 503 (never owner-fallback).
    const authorization = getContainer().authorization;
    if (!authorization) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        slug: node.slug,
        key,
        op,
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
    const decision = await authorization.check({
      actorId: `user:${sessionUser.id}`,
      action: "node.manage_secrets",
      resource: `node:${node.id}`,
      context: { tenantId: node.id, nodeId: node.id },
    });
    if (decision.decision !== "allow") {
      const code = decision.code as AuthzErrorCode;
      const status = code === "authz_unavailable" ? 503 : 403;
      logTerminal({
        outcome: "error",
        status,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        env: requestedEnv,
        errorCode: code,
      });
      return NextResponse.json(
        {
          error:
            code === "authz_unavailable"
              ? "authorization unavailable"
              : "not authorized",
          errorCode: code,
        },
        { status }
      );
    }

    // Gate 2 — substrate-reserved-key guard. The node owns its whole
    // cogni/<env>/<node>/* namespace and may add/set/rotate any key (RBAC +
    // path-scope is the boundary); only refuse substrate-managed keys (DB
    // creds/DSNs/auth) so an owner can't clobber their own substrate.
    if (!isNodeOwnedSecretKey(key)) {
      logTerminal({
        outcome: "error",
        status: 403,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        env: requestedEnv,
        errorCode: "key_reserved",
      });
      return NextResponse.json(
        {
          error: "key is substrate-managed and cannot be set via self-serve",
          errorCode: "key_reserved",
        },
        { status: 403 }
      );
    }

    let plane: OperatorSecretsPlanePort;
    try {
      plane = createOperatorSecretsPlane(env);
    } catch (error) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        env: requestedEnv,
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

    try {
      const result = await plane.writeSecret({
        nodeSlug: node.slug,
        env: deployEnv,
        key,
        value,
        op,
      });
      logTerminal({
        outcome: "success",
        status: 200,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        env: deployEnv,
        version: result.version,
      });
      return NextResponse.json({
        written: result.written,
        version: result.version,
        path: result.path,
      });
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "secret_write_failed";
      logTerminal({
        outcome: "error",
        status: 502,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        env: deployEnv,
        errorCode,
      });
      return NextResponse.json(
        { error: "secret write failed", errorCode },
        { status: 502 }
      );
    }
  }
);
