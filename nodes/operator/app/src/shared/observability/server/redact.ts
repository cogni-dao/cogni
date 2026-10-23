// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/redact`
 * Purpose: Redaction paths for sensitive data in logs.
 * Scope: Define paths to redact from log output, plus a bounded error-code sanitizer for log fields.
 * Invariants: Only redact known secret-bearing keys (not generic "url").
 * Side-effects: none
 * Notes: Used by pino redact configuration during logger initialization.
 * Links: Imported by logger module; defines sensitive path patterns.
 * @public
 */

export const REDACT_PATHS = [
  // Auth & secrets
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "apiKey",
  "api_key",
  "AUTH_SECRET",
  // HTTP headers
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "headers.authorization",
  "headers.cookie",
  // Wallet/crypto
  "privateKey",
  "mnemonic",
  "seed",
];

/**
 * Low-cardinality log field from a code-authored error message (bug.5519):
 * snake_case, at most 64 chars; never request data or credentials.
 */
export function toLogErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "non_error_thrown";
  const code = error.message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return code || error.name;
}
