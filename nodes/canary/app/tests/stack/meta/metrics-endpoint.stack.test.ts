// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/meta/metrics-endpoint.stack`
 * Purpose: Verify /api/metrics endpoint returns Prometheus format with expected metrics.
 * Scope: Black-box HTTP checks against running stack. Does not test metric values, only presence.
 * Invariants: Uses TEST_BASE_URL for host; METRICS_TOKEN for auth; assumes stack started via dev:stack:test.
 * Side-effects: IO
 * Notes: Requires running stack; tests metric names and format, not values.
 * Links: /api/metrics
 * @public
 */

import { describe, expect, test } from "vitest";

function baseUrl(path: string): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000/";
  return new URL(path.replace(/^\//, ""), root).toString();
}

// Token from env or default dev token
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "dev-metrics-token";

describe("Metrics Endpoint", () => {
  test("[meta] /api/metrics returns 401 without token", async () => {
    // Token is always required - no dev mode exception
    const response = await fetch(baseUrl("/api/metrics"));
    expect(response.status).toBe(401);
  });

  test("[meta] /api/metrics returns prometheus format with valid token", async () => {
    const response = await fetch(baseUrl("/api/metrics"), {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const body = await response.text();

    // Verify HTTP metrics
    expect(body).toContain("http_requests_total");
    expect(body).toContain("http_request_duration_ms");

    // Verify AI metrics
    expect(body).toContain("ai_chat_stream_duration_ms");
    expect(body).toContain("ai_llm_call_duration_ms");
    expect(body).toContain("ai_llm_tokens_total");
    expect(body).toContain("ai_llm_cost_usd_total");
    expect(body).toContain("ai_llm_errors_total");

    // Verify default Node.js metrics (from prom-client collectDefaultMetrics)
    expect(body).toContain("process_cpu");
    expect(body).toContain("nodejs_heap");
  });

  test("[meta] /api/metrics handles case-insensitive bearer prefix", async () => {
    // Test lowercase "bearer"
    const response = await fetch(baseUrl("/api/metrics"), {
      headers: { Authorization: `bearer ${METRICS_TOKEN}` },
    });

    expect(response.status).toBe(200);
  });
});
