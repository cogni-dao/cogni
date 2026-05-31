// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/metrics`
 * Purpose: Prometheus metrics endpoint for Alloy/Prometheus scraping.
 * Scope: Exposes metrics registry. Protected by bearer token auth. Does not define or record metrics.
 * Invariants: METRICS_TOKEN required; constant-time compare; auth header capped at 512 bytes.
 * Side-effects: IO (reads metrics registry, records HTTP metrics)
 * Notes: Bearer token auth case-insensitive. Wrapped for consistent reqId and HTTP metrics.
 * Links: Consumed by Alloy scraper, Prometheus, or Grafana Cloud.
 * @public
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { metricsRegistry } from "@/shared/observability";

// Force Node.js runtime (prom-client not Edge-compatible)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Cap header length to prevent DoS
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;

  // Case-insensitive prefix match
  const trimmed = authHeader.trim();
  const lowerPrefix = trimmed.toLowerCase();

  if (!lowerPrefix.startsWith("bearer ")) return null;

  // Extract and trim the token (after "bearer ")
  const token = trimmed.slice(7).trim();

  // Cap token length after parsing (before hashing)
  if (token.length > MAX_TOKEN_LENGTH) return null;

  return token;
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.metrics", auth: { mode: "none" } },
  async (_ctx, request) => {
    const env = serverEnv();
    const configuredToken = env.METRICS_TOKEN;

    // METRICS_TOKEN must be set in all environments
    if (!configuredToken) {
      return NextResponse.json(
        { error: "METRICS_TOKEN not configured" },
        { status: 500 }
      );
    }

    // Require valid bearer token auth
    const authHeader = request.headers.get("authorization");
    const providedToken = extractBearerToken(authHeader);

    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const metrics = await metricsRegistry.metrics();
    return new NextResponse(metrics, {
      headers: {
        "Content-Type": metricsRegistry.contentType,
        "Cache-Control": "no-store",
      },
    });
  }
);
