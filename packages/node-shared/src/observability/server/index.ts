// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/observability/server`
 * Purpose: Server-side observability utilities that are pure (no pino/prom-client runtime deps).
 * Scope: logEvent wrapper + request lifecycle helpers (type-only pino dependency). Does NOT include logger factory, metrics, or redact.
 * Invariants: PURE_LIBRARY — logger/metrics/redact stay app-local.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

export {
  logRequestEnd,
  logRequestError,
  logRequestStart,
  logRequestWarn,
} from "./helpers";
export { logEvent } from "./logEvent";
