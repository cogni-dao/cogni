// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/redact`
 * Purpose: Redaction paths for sensitive data in logs.
 * Scope: Define paths to redact from log output. Does not implement redaction logic.
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
