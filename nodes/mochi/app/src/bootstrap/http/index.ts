// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/http`
 * Purpose: HTTP route utilities for bootstrapping.
 * Scope: Bootstrap-layer exports; creates bound wrapPublicRoute singleton lazily. Does NOT handle request-scoped lifecycle or business logic.
 * Invariants: All /api/v1/public/** routes MUST use wrapPublicRoute(); enforced by CI test.
 * Side-effects: global (lazy container init on first request via dynamic import, not module import)
 * Notes: Container init deferred to first actual request to avoid build-time env validation.
 * Links: Re-exports from bootstrap/http/*; CI enforcement in tests/meta/public-route-enforcement.test.ts.
 * @public
 */

import { type NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/shared/observability";
import { publicApiLimiter } from "./rateLimiter";
import { makeWrapPublicRoute, type PublicRouteConfig } from "./wrapPublicRoute";

export {
  extractClientIp,
  publicApiLimiter,
  TokenBucketRateLimiter,
} from "./rateLimiter";
export { wrapRouteHandlerWithLogging } from "./wrapRouteHandlerWithLogging";

// Lazy singleton - initialized on first REQUEST, not first import
let _wrapPublicRoute: ReturnType<typeof makeWrapPublicRoute> | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Public route wrapper - bound to container config singleton.
 * Lazily initialized on first REQUEST (not import) to avoid build-time env validation.
 *
 * All routes under /api/v1/public/** MUST use this wrapper.
 *
 * @example
 * export const GET = wrapPublicRoute(
 *   { routeId: "analytics.summary", cacheTtlSeconds: 60 },
 *   async (ctx, request) => {
 *     const data = await getSomePublicData();
 *     return NextResponse.json(data);
 *   }
 * );
 */
export function wrapPublicRoute<TContext = unknown>(
  config: PublicRouteConfig,
  handler: Parameters<ReturnType<typeof makeWrapPublicRoute>>[1]
): (request: NextRequest, context?: TContext) => Promise<Response> {
  // Return handler that defers container init to first request
  return async (
    request: NextRequest,
    context?: TContext
  ): Promise<Response> => {
    // Concurrency-safe lazy init
    if (!_wrapPublicRoute) {
      _initPromise ??= (async () => {
        // Dynamic import: breaks Turbopack's per-route static module graph tracing (spike.0203)
        const { getContainer } = await import("@/bootstrap/container");
        const container = getContainer();
        _wrapPublicRoute = makeWrapPublicRoute({
          rateLimitBypass: container.config.rateLimitBypass,
          rateLimiter: publicApiLimiter,
          DEPLOY_ENVIRONMENT: container.config.DEPLOY_ENVIRONMENT,
        });
      })();
      try {
        await _initPromise;
      } catch (bootError) {
        // Reset promise so next request retries init (container may recover)
        _initPromise = null;
        const fallbackLog = makeLogger({ component: "wrapPublicRoute" });
        fallbackLog.error(
          {
            errorCode: "CONTAINER_INIT_FAILED",
            err:
              bootError instanceof Error
                ? bootError.message
                : String(bootError),
          },
          "container initialization failed — returning 503"
        );
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: "CONTAINER_INIT_FAILED",
            message:
              bootError instanceof Error
                ? bootError.message
                : "Unknown container initialization error",
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          }
        );
      }
    }
    if (!_wrapPublicRoute) throw new Error("wrapPublicRoute init failed");
    return _wrapPublicRoute(config, handler)(request, context);
  };
}
