// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/context/factory`
 * Purpose: Factory for creating request-scoped context with sanitized reqId.
 * Scope: Create RequestContext with child logger; sanitize incoming x-request-id. Does not manage context lifecycle.
 * Invariants: reqId is validated; routeId is stable; child logger binds userId from session when present.
 * Side-effects: none
 * Notes: Use in route handlers to create ctx for request. Cross-cutting observability concern.
 * Links: Returns RequestContext type; called at route handler entry points; referenced by https://node-template.cognidao.org/knowledge/observability-logging-contract § Context Propagation.
 * @public
 */

import type { Logger } from "pino";

import type { SessionUser } from "../../auth";
import type { Clock, RequestContext } from "./types";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_REQ_ID_LENGTH = 64;
const REQ_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Sanitize incoming x-request-id header to prevent injection attacks.
 * Max 64 chars, alphanumeric + _- only.
 */
function sanitizeReqId(incoming: string | null): string {
  if (
    incoming &&
    incoming.length <= MAX_REQ_ID_LENGTH &&
    REQ_ID_PATTERN.test(incoming)
  ) {
    return incoming;
  }
  return crypto.randomUUID();
}

/**
 * Create request-scoped context with child logger.
 *
 * @param deps - Dependencies: baseLog (root logger), clock (time provider)
 * @param request - Incoming HTTP request
 * @param meta - Request metadata (routeId, traceId, session)
 * @returns RequestContext with child logger (reqId, traceId, route, method bound)
 */
export function createRequestContext(
  deps: { baseLog: Logger; clock: Clock },
  request: Request,
  meta: { routeId: string; traceId: string; session?: SessionUser | undefined }
): RequestContext {
  const reqId = sanitizeReqId(request.headers.get(REQUEST_ID_HEADER));

  return {
    log: deps.baseLog.child({
      reqId,
      traceId: meta.traceId,
      route: meta.routeId,
      method: request.method,
      userId: meta.session?.id,
    }),
    reqId,
    traceId: meta.traceId,
    routeId: meta.routeId,
    session: meta.session,
    clock: deps.clock,
  };
}
