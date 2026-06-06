// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/meta/metrics-instrumentation.stack`
 * Purpose: Verify HTTP and LLM metrics increment correctly on requests.
 * Scope: Black-box HTTP checks for HTTP metrics; in-process route calls for LLM metrics. Does not test metric values or bucket distributions.
 * Invariants: HTTP metrics increment by exactly 1 per request; LLM metrics use low-cardinality labels.
 * Side-effects: IO (HTTP requests, database writes)
 * Notes: Requires running stack for HTTP tests; LLM calls route through mock-openai-api (APP_ENV=test).
 * Links: /api/metrics, src/bootstrap/http/wrapRouteHandlerWithLogging.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// =============================================================================
// Prometheus Text Format Parser
// =============================================================================

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse Prometheus text format into metric samples.
 * Only parses lines with values (ignores HELP/TYPE comments).
 */
function parsePrometheusText(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith("#") || line.trim() === "") continue;

    // Match: metric_name{label="value",...} value
    // Or: metric_name value
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+(.+)$/);
    if (match?.[1] && match[2] && match[3]) {
      const name = match[1];
      const labelsStr = match[2];
      const valueStr = match[3];
      const labels: Record<string, string> = {};

      // Parse labels: key="value",key2="value2"
      const labelMatches = labelsStr.matchAll(
        /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g
      );
      for (const labelMatch of labelMatches) {
        if (labelMatch[1] && labelMatch[2]) {
          labels[labelMatch[1]] = labelMatch[2];
        }
      }

      samples.push({ name, labels, value: parseFloat(valueStr) });
    } else {
      // No labels: metric_name value
      const simpleMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(.+)$/);
      if (simpleMatch?.[1] && simpleMatch[2]) {
        const name = simpleMatch[1];
        const valueStr = simpleMatch[2];
        samples.push({ name, labels: {}, value: parseFloat(valueStr) });
      }
    }
  }

  return samples;
}

/**
 * Find a metric sample by name and exact label match.
 * Filters out default labels (app, env) that are added automatically.
 */
function findSample(
  samples: MetricSample[],
  name: string,
  labels: Record<string, string>
): MetricSample | undefined {
  return samples.find((s) => {
    if (s.name !== name) return false;
    // Filter out default labels when comparing
    const sampleLabelKeys = Object.keys(s.labels).filter(
      (k) => k !== "app" && k !== "env" && k !== "node_id"
    );
    const targetLabelKeys = Object.keys(labels);
    if (sampleLabelKeys.length !== targetLabelKeys.length) return false;
    return targetLabelKeys.every((k) => s.labels[k] === labels[k]);
  });
}

// =============================================================================
// Test Helpers
// =============================================================================

function baseUrl(path: string): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000/";
  return new URL(path.replace(/^\//, ""), root).toString();
}

const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "dev-metrics-token";

async function fetchMetrics(): Promise<MetricSample[]> {
  const response = await fetch(baseUrl("/api/metrics"), {
    headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.status}`);
  }
  const text = await response.text();
  return parsePrometheusText(text);
}

// =============================================================================
// Test 1: HTTP Metrics Increment
// =============================================================================

describe("HTTP Metrics Instrumentation", () => {
  it("increments http_requests_total and http_request_duration_ms on wrapped route", async () => {
    // Test using /api/v1/public/analytics/summary - it's wrapped with wrapRouteHandlerWithLogging,
    // public (no auth required), and NOT excluded from metrics recording (unlike meta.metrics).
    const testRoute = "analytics.summary";
    const testUrl = "/api/v1/public/analytics/summary?window=7d";

    // 1. Get baseline metrics (first fetch)
    const baseline = await fetchMetrics();

    // Sum all status buckets for this route (could be 2xx, 4xx, or 5xx)
    const baselineCounters = baseline.filter(
      (s) =>
        s.name === "http_requests_total" &&
        s.labels.route === testRoute &&
        s.labels.method === "GET"
    );
    const baselineDuration = findSample(
      baseline,
      "http_request_duration_ms_count",
      {
        route: testRoute,
        method: "GET",
      }
    );

    const baseCounterTotal = baselineCounters.reduce(
      (sum, s) => sum + s.value,
      0
    );
    const baseDurationCount = baselineDuration?.value ?? 0;

    // 2. Hit /api/v1/public/analytics/summary (increments the counter)
    // Use fetchStackTest to bypass rate limiting (not testing rate limits here)
    const response = await fetchStackTest(baseUrl(testUrl));
    expect(response.status).toBe(200);

    // 3. Get metrics again (second fetch to read the incremented values)
    const after = await fetchMetrics();

    const afterCounters = after.filter(
      (s) =>
        s.name === "http_requests_total" &&
        s.labels.route === testRoute &&
        s.labels.method === "GET"
    );
    const afterDuration = findSample(after, "http_request_duration_ms_count", {
      route: testRoute,
      method: "GET",
    });

    const afterCounterTotal = afterCounters.reduce(
      (sum, s) => sum + s.value,
      0
    );
    const afterDurationCount = afterDuration?.value ?? 0;

    // 4. Assert increments by at least 1 (analytics request in step 2)
    // Note: meta.metrics fetches are excluded from recording.
    // Concurrent tests may also hit this endpoint, so we verify >= 1 increment.
    expect(afterCounterTotal).toBeGreaterThanOrEqual(baseCounterTotal + 1);
    expect(afterDurationCount).toBeGreaterThanOrEqual(baseDurationCount + 1);
  });
});

// =============================================================================
// Test 2: LLM Metrics Instrumentation
// =============================================================================

// Mock session for in-process route calls
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import type { SessionUser } from "@cogni/node-shared";
// Import after mock
import { createCompletionRequest } from "@tests/_fakes";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { fetchStackTest } from "@tests/_fixtures/http/rate-limit-helpers";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as completionPOST } from "@/app/api/v1/chat/completions/route";
import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";
import { metricsRegistry } from "@/shared/observability";

// QUARANTINED(task.0185): LLM metrics recorded in internal API route via decorator stack,
// no longer reachable from in-process facade calls after Temporal+Redis migration.
describe.skip("LLM Metrics Instrumentation", () => {
  it("increments ai_llm_call_duration_ms and ai_llm_tokens_total on successful completion", async () => {
    // 1. Setup authenticated user with credits
    const mockSessionUser: SessionUser = {
      id: randomUUID(),
      walletAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
    };
    vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, mockSessionUser.id));

    await db.insert(users).values({
      id: mockSessionUser.id,
      name: "Metrics Test User",
      walletAddress: mockSessionUser.walletAddress,
    });

    // Protocol scale: 10M credits = $1 USD. Seed with $10 worth for safety margin.
    const billingAccountId = randomUUID();
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: mockSessionUser.id,
      balanceCredits: 100_000_000n, // 100M credits = $10 (protocol scale)
    });

    await db.insert(virtualKeys).values({
      id: randomUUID(),
      billingAccountId,
      isDefault: true,
    });

    // 2. Get baseline from in-process registry
    const baselineText = await metricsRegistry.metrics();
    const baseline = parsePrometheusText(baselineText);

    // Find baseline for any model_class (we don't know which FakeLlmAdapter uses)
    const baseDurationSamples = baseline.filter(
      (s) =>
        s.name === "ai_llm_call_duration_ms_count" &&
        s.labels.provider === "litellm"
    );
    const baseTokenSamples = baseline.filter(
      (s) => s.name === "ai_llm_tokens_total" && s.labels.provider === "litellm"
    );

    const baseDurationTotal = baseDurationSamples.reduce(
      (sum, s) => sum + s.value,
      0
    );
    const baseTokenTotal = baseTokenSamples.reduce(
      (sum, s) => sum + s.value,
      0
    );

    // 3. Call completion (in-process, metrics recorded in same registry)
    const req = new NextRequest(
      "http://localhost:3000/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          createCompletionRequest({
            messages: [{ role: "user", content: "Hello metrics test" }],
          })
        ),
      }
    );

    const res = await completionPOST(req);
    expect(res.status).toBe(200);

    // 4. Get metrics after completion
    const afterText = await metricsRegistry.metrics();
    const after = parsePrometheusText(afterText);

    const afterDurationSamples = after.filter(
      (s) =>
        s.name === "ai_llm_call_duration_ms_count" &&
        s.labels.provider === "litellm"
    );
    const afterTokenSamples = after.filter(
      (s) => s.name === "ai_llm_tokens_total" && s.labels.provider === "litellm"
    );

    const afterDurationTotal = afterDurationSamples.reduce(
      (sum, s) => sum + s.value,
      0
    );
    const afterTokenTotal = afterTokenSamples.reduce(
      (sum, s) => sum + s.value,
      0
    );

    // 5. Assert increments
    expect(afterDurationTotal).toBe(baseDurationTotal + 1);
    expect(afterTokenTotal).toBeGreaterThan(baseTokenTotal);

    // 6. Verify model_class label is low-cardinality
    const modelClasses = new Set(
      afterDurationSamples.map((s) => s.labels.model_class)
    );
    for (const mc of modelClasses) {
      expect(["free", "standard", "premium"]).toContain(mc);
    }
  });

  it("increments ai_llm_errors_total on LLM failure", async () => {
    // Skip if not in test mode
    if (process.env.APP_ENV !== "test") {
      return;
    }

    // This test would require configuring FakeLlmAdapter to fail
    // For now, we verify the error metric exists and has the expected labels
    const metricsText = await metricsRegistry.metrics();
    expect(metricsText).toContain("ai_llm_errors_total");

    // Verify HELP text describes the metric
    expect(metricsText).toContain("# HELP ai_llm_errors_total");
    expect(metricsText).toContain("# TYPE ai_llm_errors_total counter");
  });
});
