// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/http/wrapRouteHandlerWithLogging`
 * Purpose: Route wrapper to eliminate boilerplate for request logging envelope and metrics.
 * Scope: Bootstrap-layer utility. Handles ctx creation, timing, envelope logging, and Prometheus metrics. Does not implement route-specific business logic.
 * Invariants: Always logs request start/end exactly once; always measures duration; catches unhandled errors; always records metrics (even on 5xx).
 * Side-effects: IO (creates request context, emits structured log entries, records Prometheus metrics). Container loaded via dynamic import to avoid Turbopack per-route module duplication.
 * Notes: Use this wrapper for all instrumented routes. Domain events go in facades/features, not here.
 *        logRequestEnd runs exactly once in the finally block for all paths (success, 401, 5xx).
 *        401 on required routes emits a RFC 6750 §3 `WWW-Authenticate` header: a
 *        presented-but-invalid bearer (e.g. expired) → `Bearer error="invalid_token", ...`
 *        + body `{error:"invalid_token", error_description}`; a missing credential →
 *        bare `Bearer` + body `{error:"Session required"}`.
 *        For unhandled errors: logs error, then rethrows in dev/test (APP_ENV != production) for diagnosis.
 *        In production, converts to 500 for safety.
 *        Metrics are recorded in a finally block to ensure all paths are captured.
 * Links: Used by route handlers; delegates to shared/observability helpers; records to shared/observability/server/metrics.
 * @public
 */

import type { SessionUser } from "@cogni/node-shared";
import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { withRootSpan } from "@/bootstrap/otel";
import {
  createRequestContext,
  httpRequestDurationMs,
  httpRequestsTotal,
  logRequestEnd,
  logRequestError,
  logRequestStart,
  type RequestContext,
  statusBucket,
} from "@/shared/observability";

// Agent bearer token prefix (kept in sync with the auth layer's issuer). Used
// ONLY to decode a rejected token's expiry for a human-readable challenge
// description — never to verify it. Duplicated here (not imported from
// `@/app/_lib/auth`) so the bootstrap layer stays free of an app dependency
// (dependency-cruiser layer boundary: bootstrap → bootstrap/ports/adapters/shared/types).
const AGENT_TOKEN_PREFIX = "cogni_ag_sk_v1_";

type AuthChallenge = {
  wwwAuthenticate: string;
  body:
    | { error: "invalid_token"; error_description: string }
    | { error: "Session required" };
};

/**
 * Refine the RFC 6750 §3 challenge description for a rejected bearer. Decode-only
 * (no HMAC verify): an invalid signature and an expired token are BOTH
 * `invalid_token` per the spec — we only surface expiry as the actionable case
 * (bug.5069: an aged-out key was masked as a session outage).
 */
function bearerRejectionDescription(token: string): string {
  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    const payloadB64 = token.slice(AGENT_TOKEN_PREFIX.length).split(".")[0];
    if (payloadB64) {
      try {
        const parsed = JSON.parse(
          Buffer.from(payloadB64, "base64url").toString("utf8")
        ) as { exp?: number };
        if (
          typeof parsed.exp === "number" &&
          parsed.exp < Math.floor(Date.now() / 1000)
        ) {
          return "The access token expired";
        }
      } catch {
        // Undecodable payload → fall through to the generic description.
      }
    }
  }
  return "The access token is invalid";
}

/**
 * Build the 401 challenge for a `required` route that resolved a null identity.
 * Header-only (reads the SAME `next/headers` source the identity resolver uses;
 * no session/DB IO): distinguishes a presented-but-invalid bearer (RFC 6750 §3
 * `invalid_token`, expiry surfaced) from a missing credential (bare `Bearer`
 * challenge, session-required semantics preserved). Lives in the bootstrap layer
 * so the wrapper never imports from `@/app/_lib/auth`.
 */
async function buildAuthChallenge(): Promise<AuthChallenge> {
  let authHeader: string | null = null;
  try {
    authHeader = (await headers()).get("authorization");
  } catch {
    authHeader = null;
  }
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { wwwAuthenticate: "Bearer", body: { error: "Session required" } };
  }
  const token = authHeader.slice(7).trimStart();
  const description = bearerRejectionDescription(token);
  return {
    wwwAuthenticate: `Bearer error="invalid_token", error_description="${description}"`,
    body: { error: "invalid_token", error_description: description },
  };
}

type AuthRequiredHandler<TContext = unknown> = (
  ctx: RequestContext,
  request: NextRequest,
  sessionUser: SessionUser,
  context?: TContext
) => Promise<NextResponse>;

type AuthOptionalHandler<TContext = unknown> = (
  ctx: RequestContext,
  request: NextRequest,
  sessionUser: SessionUser | null,
  context?: TContext
) => Promise<NextResponse>;

type AuthRequiredOptions = {
  routeId: string;
  auth: {
    mode: "required";
    getSessionUser: () => Promise<SessionUser | null>;
  };
};

type AuthOptionalOptions = {
  routeId: string;
  auth: {
    mode: "optional";
    getSessionUser: () => Promise<SessionUser | null>;
  };
};

type AuthNoneOptions = {
  routeId: string;
  auth?: { mode: "none" };
};

type WrapOptions = AuthRequiredOptions | AuthOptionalOptions | AuthNoneOptions;

/**
 * Wraps a route handler with consistent request logging envelope.
 * Handles ctx creation, session check, timing, logRequestStart/End/Error automatically.
 *
 * @param options - Configuration for route logging
 * @param options.routeId - Route identifier for logging (e.g., "payments.intents")
 * @param options.auth - Session authentication config: { mode: "required"|"optional"|"none", getSessionUser }
 * @param handler - Route handler that receives (ctx, request, sessionUser, context?)
 * @returns Next.js route handler function (supports both static and dynamic routes)
 *
 * @example
 * // Static route with required session — sessionUser is guaranteed non-null
 * export const POST = wrapRouteHandlerWithLogging(
 *   { routeId: "payments.intents", auth: { mode: "required", getSessionUser } },
 *   async (ctx, request, sessionUser) => {
 *     const body = await request.json();
 *     const input = paymentIntentOperation.input.parse(body);
 *     const result = await createPaymentIntentFacade({ sessionUser, ...input }, ctx);
 *     return NextResponse.json(paymentIntentOperation.output.parse(result));
 *   }
 * );
 *
 * @example
 * // Dynamic route (Next.js 15 with async params and typed context)
 * export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
 *   { routeId: "payments.attempt_status", auth: { mode: "required", getSessionUser } },
 *   async (ctx, request, sessionUser, context) => {
 *     if (!context) throw new Error("context required for dynamic routes");
 *     const { id } = await context.params;
 *     const result = await getPaymentStatusFacade({ sessionUser, attemptId: id }, ctx);
 *     return NextResponse.json(paymentStatusOperation.output.parse(result));
 *   }
 * );
 */
// Overload: mode "required" → handler receives SessionUser (non-null)
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: AuthRequiredOptions,
  handler: AuthRequiredHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse>;
// Overload: mode "optional" or "none" → handler receives SessionUser | null
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: AuthOptionalOptions | AuthNoneOptions,
  handler: AuthOptionalHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse>;
// Implementation
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: WrapOptions,
  handler: AuthRequiredHandler<TContext> | AuthOptionalHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse> {
  return async (
    request: NextRequest,
    context?: TContext
  ): Promise<NextResponse> => {
    // Dynamic import: breaks Turbopack's per-route static module graph tracing
    // of the entire DI composition root (spike.0203 — was causing 6GB RSS in dev).
    const { getContainer } = await import("@/bootstrap/container");
    const container = getContainer();

    // Fetch session based on auth mode
    const sessionUser =
      options.auth && options.auth.mode !== "none"
        ? await options.auth.getSessionUser()
        : null;

    // Get config once before try block to avoid env failures masking real errors
    const { unhandledErrorPolicy } = container.config;

    // Wrap entire request in OTel root span for distributed tracing
    // Per AI_SETUP_SPEC.md: root span bound to context via context.with()
    return withRootSpan(
      `${request.method} ${options.routeId}`,
      { route_id: options.routeId },
      async ({ traceId, span }) => {
        const ctx = createRequestContext(
          { baseLog: container.log, clock: container.clock },
          request,
          {
            routeId: options.routeId,
            traceId,
            session: sessionUser ?? undefined,
          }
        );

        // Per AI_SETUP_SPEC.md: request_id must be on root span for trace-log correlation
        span.setAttribute("request_id", ctx.reqId);

        logRequestStart(ctx.log);
        const start = performance.now();

        // Track response for metrics/logging (captured in try/catch, used in finally)
        let responseStatus = 500;
        let response: NextResponse;

        try {
          // Check session requirement before calling handler
          if (options.auth?.mode === "required" && !sessionUser) {
            responseStatus = 401;
            // Distinguish "presented-but-invalid credential" (e.g. an expired
            // bearer → RFC 6750 §3 `invalid_token`) from "no credential at all"
            // (bare `Bearer` challenge, session-required semantics preserved).
            const challenge = await buildAuthChallenge();
            response = NextResponse.json(challenge.body, {
              status: responseStatus,
              headers: { "WWW-Authenticate": challenge.wwwAuthenticate },
            });
            return response;
          }

          // Safe cast: for mode "required", the guard above returns 401 if null.
          // For mode "optional"/"none", handlers accept null. Either way, this is sound.
          response = await (handler as AuthOptionalHandler<TContext>)(
            ctx,
            request,
            sessionUser,
            context
          );
          responseStatus = response.status;
          return response;
        } catch (error) {
          // Wrapper only catches unhandled errors - route should handle domain errors
          responseStatus = 500;
          logRequestError(ctx.log, error, "INTERNAL_SERVER_ERROR");

          if (unhandledErrorPolicy === "rethrow") {
            throw error;
          }

          // respond_500: convert to 500 for production safety
          response = NextResponse.json(
            { error: "Internal server error" },
            { status: responseStatus }
          );
          return response;
        } finally {
          // Always log request end exactly once and record metrics
          const durationMs = performance.now() - start;

          logRequestEnd(ctx.log, { status: responseStatus, durationMs });

          // Skip metrics recording for scraper endpoint to avoid polluting user traffic metrics
          if (options.routeId !== "meta.metrics") {
            httpRequestsTotal.inc({
              route: options.routeId,
              method: request.method,
              status: statusBucket(responseStatus),
            });
            httpRequestDurationMs.observe(
              { route: options.routeId, method: request.method },
              durationMs
            );
          }
        }
      }
    );
  };
}
