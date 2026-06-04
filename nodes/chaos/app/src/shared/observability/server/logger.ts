// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/logger`
 * Purpose: Pino logger factory - JSON-only stdout emission.
 * Scope: Create configured pino loggers. Does not handle request-scoped logging.
 * Invariants: Always emits JSON to stdout; no worker transports; env label added by Alloy. Safe to call at module scope (no env validation).
 * Side-effects: none
 * Notes: Use makeLogger for app logger; use makeNoopLogger for tests. Formatting via external pipe (pino-pretty).
 * Notes: Reads logging-specific env vars directly (NODE_ENV, PINO_LOG_LEVEL, SERVICE_NAME) without serverEnv() to avoid triggering full env validation at module load time.
 * Links: Initializes redaction paths via REDACT_PATHS; used by container and route handlers.
 * @public
 */

import type { Logger } from "pino";
import pino from "pino";

import { REDACT_PATHS } from "./redact";

export type { Logger } from "pino";

export function makeLogger(bindings?: Record<string, unknown>): Logger {
  const isVitest = process.env.VITEST === "true";
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const pinoLogLevel = process.env.PINO_LOG_LEVEL ?? "info";
  const serviceName = process.env.SERVICE_NAME ?? "app";

  // Silence logs in test tooling (VITEST or NODE_ENV=test)
  const isTestTooling = isVitest || nodeEnv === "test";

  const config = {
    level: pinoLogLevel,
    enabled: !isTestTooling,
    // Stable base: bindings first, then reserved keys (prevents overwrite)
    // env label added by Alloy from DEPLOY_ENVIRONMENT, not in app logs
    base: { ...bindings, app: "cogni-template", service: serviceName },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime, // RFC3339 format (matches Alloy stage.timestamp)
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  // Always emit JSON to stdout (fd 1)
  // Sync mode + zero buffering until proven stable (prevents delayed/missing logs under SSE)
  // Formatting happens externally (pipe to pino-pretty if desired)
  return pino(
    config,
    pino.destination({
      dest: 1,
      sync: true,
      minLength: 0,
    })
  );
}

/**
 * For tests - pino with enabled:false (preserves type, silences output)
 */
export function makeNoopLogger(): Logger {
  return pino({ enabled: false });
}
