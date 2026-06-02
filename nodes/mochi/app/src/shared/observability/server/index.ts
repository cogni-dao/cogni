// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/server`
 * Purpose: Server-side logging utilities — app-local (pino/prom-client) + extracted (@cogni/node-shared) helpers.
 * Scope: Re-exports from app-local logger/metrics/redact + package logEvent/helpers.
 * Invariants: none
 * Side-effects: IO (logging to stdout)
 * @public
 */

// Extracted to @cogni/node-shared
export {
  logEvent,
  logRequestEnd,
  logRequestError,
  logRequestStart,
  logRequestWarn,
} from "@cogni/node-shared";
// App-local (pino runtime, prom-client runtime)
export * from "./logger";
export * from "./metrics";
export { REDACT_PATHS } from "./redact";
