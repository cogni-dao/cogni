// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/secrets`
 * Purpose: Node-owner self-serve secret VALUE write/rotate. A `developer` on the
 *   node sets `cogni/<env>/<node>/<KEY>` through the operator pod's own OpenBao
 *   identity — caller holds only an API key. The value-write sibling of vcs/flight.
 * Scope: auth → OpenFGA gate → catalog allowlist gate → secrets plane port.
 *   Write/rotate only; key-name listing (GET) is deferred.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer (agents) or SIWE session. No open access.
 *   - OPENFGA_FAIL_CLOSED: undefined authz or `authz_unavailable` → 503; not-allow → 403.
 *     Never owner-fallback for a write this sensitive (design §Security boundary).
 *   - PATH_FROM_AUTHORIZED_RESOURCE: node slug from the loaded node, env from
 *     serverEnv — never the request body (closes both cross-pollination axes).
 *   - ALLOWLIST_IS_DEPTH: gate 2 bounds key-shape (A2-only); gates 1+3 are the floor.
 *   - NO_SECRETS_IN_LOG: the value never enters a log line; only key + KV version.
 * Side-effects: IO (Postgres read, OpenBao HTTP write via OperatorSecretsPlanePort).
 * Links: docs/design/node-self-serve-secrets.md, src/app/api/v1/vcs/flight/route.ts
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorSecretsPlane } from "@/bootstrap/capabilities/operator-secrets-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import type { OperatorSecretsPlanePort } from "@/ports";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { isNodeSecretAllowed } from "@/shared/secrets/node-secrets-allowlist.data";

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
    const { key, value, op } = parsed.data;

    const db = resolveServiceDb();
    const rows = await db
      .select({ id: nodes.id, slug: nodes.slug })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);
    const node = rows[0];
    if (!node) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        key,
        op,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

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

    // Gate 2 — catalog allowlist (A2-only, this node's own keys). Depth, not floor.
    if (!isNodeSecretAllowed(node.slug, key)) {
      logTerminal({
        outcome: "error",
        status: 403,
        nodeId: id,
        slug: node.slug,
        key,
        op,
        errorCode: "key_not_allowed",
      });
      return NextResponse.json(
        {
          error: "key not declared for this node (tier A2)",
          errorCode: "key_not_allowed",
        },
        { status: 403 }
      );
    }

    // Env is operator-stamped, never from the body (closes the env axis).
    const env = serverEnv();
    const deployEnv = env.DEPLOY_ENVIRONMENT;
    if (!deployEnv) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        slug: node.slug,
        key,
        op,
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
        errorCode,
      });
      return NextResponse.json(
        { error: "secret write failed", errorCode },
        { status: 502 }
      );
    }
  }
);
