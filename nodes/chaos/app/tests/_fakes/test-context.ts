// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/test-context`
 * Purpose: Reusable test RequestContext factory to eliminate boilerplate.
 * Scope: Provides makeTestCtx() for all tests requiring RequestContext parameter. Does not replace real logger in production code.
 * Invariants: Uses makeNoopLogger() and FakeClock; reqId auto-generated if not provided.
 * Side-effects: none
 * Notes: Use in any test that calls facades/services accepting RequestContext.
 * Links: Used by unit/integration/stack tests; composes FakeClock and makeNoopLogger from _fakes.
 * @public
 */

import type { SessionUser } from "@cogni/node-shared";
import { makeNoopLogger, type RequestContext } from "@/shared/observability";
import { FakeClock } from "./fake-clock";

/** Zero trace ID for tests (since OTel SDK not running) */
const TEST_TRACE_ID = "00000000000000000000000000000000";

export interface TestCtxOptions {
  reqId?: string;
  traceId?: string;
  routeId?: string;
  session?: SessionUser;
  clockTime?: string;
}

/**
 * Create a test RequestContext with sensible defaults.
 * Uses makeNoopLogger(), FakeClock, and optional session.
 * traceId defaults to zero trace ID (OTel SDK not running in tests).
 */
export function makeTestCtx(options: TestCtxOptions = {}): RequestContext {
  const clock = new FakeClock(options.clockTime ?? "2025-01-01T00:00:00.000Z");

  return {
    log: makeNoopLogger(),
    reqId: options.reqId ?? `test-req-${Date.now()}`,
    traceId: options.traceId ?? TEST_TRACE_ID,
    routeId: options.routeId ?? "test.route",
    session: options.session,
    clock,
  };
}
