// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/observability`
 * Purpose: Cross-cutting observability — events, context, log helpers, client logger.
 * Scope: Pure observability utilities. Does NOT include logger factory (makeLogger), metrics, or redact — those stay app-local.
 * Invariants: PURE_LIBRARY — no pino runtime, no prom-client runtime.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

// Client-side logging
export * as clientLogger from "./client";
// Context
export type { Clock, RequestContext } from "./context";
export { createRequestContext } from "./context";
export type { EventBase, EventName } from "./events";
// Event Registry (shared by client and server)
export {
  EVENT_NAMES,
  KNOWLEDGE_CONTRIBUTION_DIFF_ERROR_CODES,
  WORK_ITEMS_LIST_ERROR_CODES,
} from "./events";
// Domain event payload types
export * from "./events/ai";
export * from "./events/payments";
// Server-side helpers (type-only pino dep — logger/metrics stay app-local)
export {
  logEvent,
  logRequestEnd,
  logRequestError,
  logRequestStart,
  logRequestWarn,
} from "./server";
