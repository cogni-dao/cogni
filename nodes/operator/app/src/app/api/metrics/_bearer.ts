// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/_bearer`
 * Purpose: The bearer check both Prometheus scrape routes share (`/api/metrics`, `/api/metrics/leases`).
 * Scope: Parses and compares the Authorization header. Does not read env or log.
 * Invariants: Constant-time compare over SHA-256 digests; auth header capped at 512 bytes; token at 256.
 * Side-effects: none
 * @internal
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Max auth header length to prevent DoS */
const MAX_AUTH_HEADER_LENGTH = 512;
/** Max token length after parsing (before hashing) */
const MAX_TOKEN_LENGTH = 256;

/**
 * Constant-time string comparison using SHA-256 digests.
 * Both inputs are hashed to fixed 32-byte digests, eliminating
 * attacker-controlled allocations and ensuring true constant-time comparison.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Extract bearer token from Authorization header.
 * Handles case-insensitive "Bearer " prefix, trims whitespace.
 * Returns null if header or token exceeds length limits to prevent DoS.
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;

  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;

  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;

  return token;
}

/** True when the request's bearer equals `configuredToken`. */
export function isMetricsBearerAuthorized(
  authHeader: string | null,
  configuredToken: string
): boolean {
  const provided = extractBearerToken(authHeader);
  return provided !== null && safeCompare(provided, configuredToken);
}
