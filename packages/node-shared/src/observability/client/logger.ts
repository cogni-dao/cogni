// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/client/logger`
 * Purpose: Client-side structured logging with event name registry enforcement.
 * Scope: Browser-safe logging with scrubbing and truncation. Ships warn/error to the server so client failures are observable in Loki. Does not ship debug/info, await the POST, or run outside the browser.
 * Invariants: Drops forbidden keys; truncates large values; uses EVENT_NAMES registry. Shipping is best-effort and never throws.
 * Side-effects: IO (console + fire-and-forget POST to /api/internal/observability/client-log for warn/error).
 * Notes: warn/error are shipped (browser-only); debug/info stay console-only. Enforces same EventName registry as server.
 * Links: Uses ../events.ts registry; called by client components.
 * @public
 */

import safeStringify from "fast-safe-stringify";
import type { EventName } from "../events";

/** Forbidden keys to DROP from log metadata (lowercase for comparison) */
const FORBIDDEN_KEYS = new Set([
  "prompt",
  "messages",
  "apikey",
  "authorization",
  "cookie",
  "set-cookie",
]);

/** Maximum size for a single meta value before truncation */
const MAX_VALUE_SIZE = 2048;

/** Truncate marker */
const TRUNCATED = "[TRUNCATED]";

/**
 * Shallow scrub and truncate metadata, then safely stringify
 */
function safeJson(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "{}";

  try {
    const scrubbed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(meta)) {
      // DROP forbidden keys entirely
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        continue;
      }

      // Truncate large strings
      if (typeof value === "string" && value.length > MAX_VALUE_SIZE) {
        scrubbed[key] = `${value.slice(0, MAX_VALUE_SIZE)}${TRUNCATED}`;
        continue;
      }

      // Truncate large arrays
      if (Array.isArray(value) && value.length > 100) {
        scrubbed[key] = [...value.slice(0, 100), TRUNCATED];
        continue;
      }

      scrubbed[key] = value;
    }

    // Use OSS safe-stringify for circular reference handling
    return safeStringify(scrubbed);
  } catch {
    return '"SERIALIZATION_FAILED"';
  }
}

/**
 * Best-effort ship of warn/error logs to the server so client-side failures
 * (e.g. wallet tx reverts) land in Loki instead of dying in the browser console.
 * Browser-only, fire-and-forget, never throws or recurses into the logger.
 * @param metaStr - already-scrubbed JSON string from safeJson()
 */
function shipToServer(
  level: "warn" | "error",
  event: EventName,
  metaStr: string
): void {
  if (typeof window === "undefined") return; // SSR / non-browser: no-op
  try {
    void fetch("/api/internal/observability/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"level":"${level}","event":${JSON.stringify(event)},"meta":${metaStr}}`,
      keepalive: true,
    }).catch(() => {
      // swallow — a failed log ship must never surface as an error
    });
  } catch {
    // swallow — logging must never break the app
  }
}

/**
 * Check if in development mode (runtime check for tests, build-time inline for production)
 */
function isDev(): boolean {
  // biome-ignore lint/style/noProcessEnv: Build-time constant inlined by bundler
  return process.env.NODE_ENV === "development";
}

/**
 * Debug-level logging (verbose, dev-only)
 * In production: no-op
 * In development: outputs to console
 * @param event - Event name from EVENT_NAMES registry
 */
export function debug(event: EventName, meta?: Record<string, unknown>): void {
  if (!isDev()) return;

  const metaStr = safeJson(meta);
  // biome-ignore lint/suspicious/noConsole: Client logger intentionally uses console
  console.debug(`[CLIENT] DEBUG ${event}`, metaStr);
}

/**
 * Info-level logging (informational, dev-only)
 * In production: no-op
 * In development: outputs to console
 * @param event - Event name from EVENT_NAMES registry
 */
export function info(event: EventName, meta?: Record<string, unknown>): void {
  if (!isDev()) return;

  const metaStr = safeJson(meta);
  // biome-ignore lint/suspicious/noConsole: Client logger intentionally uses console
  console.info(`[CLIENT] INFO ${event}`, metaStr);
}

/**
 * Warning-level logging (non-critical issues)
 * In production: outputs to console
 * In development: outputs to console with structured format
 * @param event - Event name from EVENT_NAMES registry
 */
export function warn(event: EventName, meta?: Record<string, unknown>): void {
  const metaStr = safeJson(meta);
  // biome-ignore lint/suspicious/noConsole: Client logger intentionally uses console
  console.warn(`[CLIENT] WARN ${event}`, metaStr);
  shipToServer("warn", event, metaStr);
}

/**
 * Error-level logging (critical issues)
 * In production: outputs to console
 * In development: outputs to console with structured format
 * @param event - Event name from EVENT_NAMES registry
 */
export function error(event: EventName, meta?: Record<string, unknown>): void {
  const metaStr = safeJson(meta);
  // biome-ignore lint/suspicious/noConsole: Client logger intentionally uses console
  console.error(`[CLIENT] ERROR ${event}`, metaStr);
  shipToServer("error", event, metaStr);
}
