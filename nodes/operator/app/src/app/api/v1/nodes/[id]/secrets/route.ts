// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/secrets`
 * Purpose: Node-owner self-serve secret VALUE write/rotate. A `secrets_manager` on the
 *   node sets `cogni/<env>/<node>/<KEY>` through the operator pod's own OpenBao
 *   identity — caller holds only an API key. The value-write sibling of vcs/flight.
 *   An optional `service` retargets the write to a PLATFORM-SERVICE bucket
 *   `cogni/<env>/<service>/<KEY>` (a non-node OpenBao path such as the Akash
 *   transaction actuator's isolated wallet bucket).
 * Scope: auth → OpenFGA gate → platform-service gate → substrate-reserved-key guard →
 *   env match → secrets plane. Write/rotate only; key-name listing (GET) is deferred.
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
 *   - PLATFORM_SERVICE_IS_OWNER_NODE_DELEGATED: `service` never relaxes or replaces the
 *     per-node check — it runs AFTER it and can only subtract. A platform service holds
 *     no OpenFGA tuples, so its bucket is administered by `PLATFORM_SERVICE_OWNER_NODE`,
 *     the same leg that mints it in secret-materialize.sh; `service` must also be in the
 *     build-time allowlist mirroring the catalog loader. No other node's grant reaches a
 *     platform-service path, and omitting `service` leaves the node path untouched.
 *   - NO_SILENT_FLEET_WIDENING: the narrower end state is a `platform_service` OpenFGA
 *     type with its own `secrets_manager` relation; it needs an RBAC model rollout
 *     (bootstrap-openfga.sh runs only inside deploy-infra) and a check against a relation
 *     an env's model lacks fails closed at 503. Owner-node delegation is therefore the
 *     narrowest authority expressible today — stated here, not implied.
 *   - NO_SECRETS_IN_LOG: the value never enters a log line; only key + env + KV version.
 * Side-effects: IO (node registry read, OpenBao HTTP write via OperatorSecretsPlanePort).
 * Links: docs/design/node-self-serve-secrets.md (Phase 3 Port alignment),
 *   src/app/api/v1/vcs/flight/route.ts, src/app/api/v1/nodes/[id]/observability/logs/route.ts
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorSecretsPlane } from "@/bootstrap/capabilities/operator-secrets-plane";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { FLIGHT_ENVS, isFlightEnv } from "@/features/nodes/flight-status";
import type { OperatorSecretsPlanePort } from "@/ports";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { isNodeOwnedSecretKey } from "@/shared/secrets/node-secrets-reserved.data";
import {
  administersPlatformServices,
  isPlatformService,
  PLATFORM_SERVICE_OWNER_NODE,
  platformServiceOwningKey,
} from "@/shared/secrets/platform-services.data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `strictObject`, not `object`: an unrecognized field is a 400, never a silent drop.
// A permissive schema let `service` be stripped by an operator build that predated the
// parameter, so the write silently fell back to the node bucket and misfiled a wallet
// credential into the publicly-consumed `cogni/<env>/operator` path — with a 200. A
// caller cannot detect a dropped field, so the server must refuse what it cannot honor;
// this makes operator/caller version skew a loud failure instead of a wrong write.
// Mirrors the deploy lane, whose `strictObject` already keeps lane/repo/ref server-owned.
const WriteSecretInput = z.strictObject({
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
  // Optional PLATFORM-SERVICE target. Absent → the node's own bucket (the only shape
  // that existed before). Present → `cogni/<env>/<service>/<KEY>`, gated below on the
  // build-time allowlist AND on the authorized node being the owner node. The charset
  // mirrors an OpenBao path segment: no `/`, no `.`, no `_shared`/`_system` reach.
  service: z
    .string()
    .min(1)
    .max(63)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      "service must be lowercase letters, digits, hyphens; start with a letter"
    )
    .optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface SecretWriteLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly slug?: string | undefined;
  readonly service?: string | undefined;
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
    const { key, value, op, env: requestedEnv, service } = parsed.data;

    // Env is an explicit `FLIGHT_ENVS` value (deploy/observability shape), validated here.
    if (!isFlightEnv(requestedEnv)) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        service,
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
        service,
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
        service,
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

    // Gate 1 — resolve + authorize via the shared node-rbac seam (same resolver the
    // node UI + flight/observability routes use). Keep this route's structured logging
    // + exact body shapes by switching on the typed failure.
    const gate = await resolveNodeAndAuthorize({
      id,
      userId: sessionUser.id,
      action: "node.manage_secrets",
    });
    if (!gate.ok) {
      logTerminal({
        outcome: "error",
        status: gate.status,
        nodeId: id,
        slug: gate.slug,
        service,
        key,
        op,
        env: requestedEnv,
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
    const node = gate.node;

    // Gate 1.5 — platform-service target. Deliberately AFTER Gate 1, so it can only ever
    // SUBTRACT from an already-granted authority: an unauthorized caller learns nothing
    // here, and a caller who is `secrets_manager` on some other node can never reach a
    // platform-service bucket. Both legs must hold.
    if (service !== undefined) {
      // (a) Build-time allowlist mirroring scripts/lib/secrets-catalog-loader.ts. An
      // arbitrary string would otherwise address any OpenBao bucket in this env.
      if (!isPlatformService(service)) {
        logTerminal({
          outcome: "error",
          status: 403,
          nodeId: id,
          slug: node.slug,
          service,
          key,
          op,
          env: requestedEnv,
          errorCode: "unknown_platform_service",
        });
        return NextResponse.json(
          {
            error:
              "service is not a declared platform service; omit it to write this node's own namespace",
            errorCode: "unknown_platform_service",
          },
          { status: 403 }
        );
      }
      // (b) Owner-node delegation. A platform service has no OpenFGA object of its own,
      // so its bucket is administered by the node that mints it in secret-materialize.sh.
      // Any other node's `can_manage_secrets` stops at its own namespace.
      if (!administersPlatformServices(node.slug)) {
        logTerminal({
          outcome: "error",
          status: 403,
          nodeId: id,
          slug: node.slug,
          service,
          key,
          op,
          env: requestedEnv,
          errorCode: "platform_service_not_owned",
        });
        return NextResponse.json(
          {
            error: `platform-service secrets are administered by node '${PLATFORM_SERVICE_OWNER_NODE}'; call that node's route`,
            errorCode: "platform_service_not_owned",
          },
          { status: 403 }
        );
      }
    }

    // Gate 1.6 — key↔service binding. Runs whether or not `service` was supplied, which
    // is the whole point: a platform-service key sent WITHOUT `service` is the misfiling
    // shape, and it is the one that silently succeeded. These keys have exactly one
    // legitimate bucket, so anything else is refused rather than written somewhere
    // plausible. This is the durable complement to the strict schema above: strictness
    // catches a field the server cannot honor, this catches a target it must not honor.
    const owningService = platformServiceOwningKey(key);
    if (owningService !== undefined && service !== owningService) {
      logTerminal({
        outcome: "error",
        status: 403,
        nodeId: id,
        slug: node.slug,
        service,
        key,
        op,
        env: requestedEnv,
        errorCode: "key_belongs_to_platform_service",
      });
      return NextResponse.json(
        {
          error: `key is owned by platform service '${owningService}'; write it with service='${owningService}' or not at all`,
          errorCode: "key_belongs_to_platform_service",
        },
        { status: 403 }
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
        service,
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
        service,
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
        service,
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
        service,
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
        service,
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
