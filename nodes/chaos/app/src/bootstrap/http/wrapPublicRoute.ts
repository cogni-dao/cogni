// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/http/wrapPublicRoute`
 * Purpose: Pure factory for public API route wrapper with mandatory rate limiting and caching.
 * Scope: Factory for route wrapper creation; enforces rate limiting, cache headers, standard error shape. Does NOT implement business logic or directly access container/env.
 * Invariants: All public routes MUST use this wrapper; rate limit 10 req/min/IP + burst 5; cache headers auto-applied; 429 on rate limit.
 * Side-effects: IO (rate limiter state, request context, metrics)
 * Notes: Pure factory enables clean testing; bootstrap/http/index.ts exports bound instance.
 * Links: Used by all /api/v1/public/** routes; CI validation in tests/meta/public-route-enforcement.test.ts
 * @public
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  logRequestWarn,
  publicRateLimitExceededTotal,
  type RequestContext,
} from "@/shared/observability";
import { extractClientIp, type TokenBucketRateLimiter } from "./rateLimiter";
import { wrapRouteHandlerWithLogging } from "./wrapRouteHandlerWithLogging";

export interface PublicRouteConfig {
  routeId: string;
  cacheTtlSeconds?: number; // Default: 60
  staleWhileRevalidateSeconds?: number; // Default: 300
}

type PublicRouteHandler<TContext = unknown> = (
  ctx: RequestContext,
  request: NextRequest,
  context?: TContext
) => Promise<NextResponse>;

/**
 * Rate limit bypass config for test environments.
 * Security: Only enabled when APP_ENV=test.
 */
export interface RateLimitBypassConfig {
  enabled: boolean;
  headerName: string;
  headerValue: string;
}

/**
 * Dependencies for public route wrapper factory.
 * Injected by bootstrap layer; no global state or env access.
 */
export interface WrapPublicRouteDeps {
  rateLimitBypass: RateLimitBypassConfig;
  rateLimiter: TokenBucketRateLimiter;
  DEPLOY_ENVIRONMENT: string;
}

/**
 * Factory to create public route wrapper with injected dependencies.
 * Pure function - no container/env dependencies.
 *
 * @example
 * // Bootstrap usage (in bootstrap/http/index.ts):
 * export const wrapPublicRoute = makeWrapPublicRoute({
 *   rateLimitBypass: getContainer().config.rateLimitBypass,
 *   rateLimiter: publicApiLimiter,
 *   DEPLOY_ENVIRONMENT: getContainer().config.DEPLOY_ENVIRONMENT,
 * });
 *
 * // Unit test usage:
 * const wrapPublicRoute = makeWrapPublicRoute({
 *   rateLimitBypass: { enabled: false, headerName: "x-stack-test", headerValue: "1" },
 *   rateLimiter: mockLimiter,
 *   DEPLOY_ENVIRONMENT: "test",
 * });
 */
export function makeWrapPublicRoute(deps: WrapPublicRouteDeps) {
  return function wrapPublicRoute<TContext = unknown>(
    config: PublicRouteConfig,
    handler: PublicRouteHandler<TContext>
  ): (request: NextRequest, context?: TContext) => Promise<NextResponse> {
    const cacheTtl = config.cacheTtlSeconds ?? 60;
    const swr = config.staleWhileRevalidateSeconds ?? 300;

    return wrapRouteHandlerWithLogging<TContext>(
      {
        routeId: config.routeId,
        auth: { mode: "none" },
      },
      async (ctx, request, _sessionUser, context) => {
        // Rate limiting with optional test bypass
        // Security: bypass only works when config.enabled=true (set by APP_ENV=test in container)
        const bypassEnabled =
          deps.rateLimitBypass.enabled &&
          request.headers.get(deps.rateLimitBypass.headerName) ===
            deps.rateLimitBypass.headerValue;

        const clientIp = extractClientIp(request);
        const allowed = bypassEnabled || deps.rateLimiter.consume(clientIp);

        if (!allowed) {
          // Log without IP (aggregated metric provides observability)
          logRequestWarn(
            ctx.log,
            {
              routeId: config.routeId,
              env: deps.DEPLOY_ENVIRONMENT,
              zone: "public_api",
            },
            "RATE_LIMIT_EXCEEDED"
          );

          // Increment counter metric (aggregated, no PII)
          publicRateLimitExceededTotal.inc({
            route: config.routeId,
            env: deps.DEPLOY_ENVIRONMENT,
          });

          return NextResponse.json(
            { error: "Rate limit exceeded" },
            {
              status: 429,
              headers: {
                "Retry-After": "60",
                "Cache-Control": "public, max-age=5", // Short cache to reduce hammering
              },
            }
          );
        }

        // Call handler
        const response = await handler(ctx, request, context);

        // Auto-apply cache headers to successful responses
        if (response.status >= 200 && response.status < 300) {
          response.headers.set(
            "Cache-Control",
            `public, max-age=${cacheTtl}, stale-while-revalidate=${swr}`
          );
        }

        return response;
      }
    );
  };
}
