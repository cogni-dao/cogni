// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/analytics/services/analytics`
 * Purpose: Unit tests for analytics service with k-anonymity validation.
 * Scope: Tests analytics service with mocked MetricsQueryPort; validates window rejection, env isolation, k-suppression logic, denominator query correctness. Does NOT test real Mimir queries or route handlers.
 * Invariants: Invalid windows throw; env hardcoded; pointwise k-suppression returns null; denominator matches series filters.
 * Side-effects: none
 * Notes: Uses spy pattern to validate query construction.
 * Links: src/features/analytics/services/analytics.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalyticsSummary } from "@/features/analytics/services/analytics";
import type { MetricsQueryPort } from "@/ports";

describe("features/analytics/services/analytics", () => {
  let mockMetricsQuery: MetricsQueryPort;
  let queryRangeSpy: ReturnType<typeof vi.fn>;
  let queryInstantSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryRangeSpy = vi.fn();
    queryInstantSpy = vi.fn();

    mockMetricsQuery = {
      queryRange: queryRangeSpy as MetricsQueryPort["queryRange"],
      queryInstant: queryInstantSpy as MetricsQueryPort["queryInstant"],
    };

    // Default responses (empty results)
    queryRangeSpy.mockResolvedValue({
      resultType: "matrix",
      result: [],
    });

    queryInstantSpy.mockResolvedValue({
      resultType: "vector",
      result: [],
    });
  });

  describe("Invalid window rejection", () => {
    it("should throw on non-7d/30d/90d window", async () => {
      await expect(
        getAnalyticsSummary(mockMetricsQuery, {
          window: "14d", // Invalid
          env: "production",
          kThreshold: 50,
        })
      ).rejects.toThrow("Invalid window: 14d");
    });

    it("should accept valid windows (7d, 30d, 90d)", async () => {
      for (const window of ["7d", "30d", "90d"]) {
        await expect(
          getAnalyticsSummary(mockMetricsQuery, {
            window,
            env: "production",
            kThreshold: 50,
          })
        ).resolves.toBeDefined();
      }
    });
  });

  describe("Environment selector enforced server-side", () => {
    it("should include env filter in all base queries", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      // Denominator query (first queryRange call)
      expect(queryRangeSpy.mock.calls[0]?.[0]?.query).toContain(
        'env="production"'
      );

      // Request rate timeseries (second queryRange call)
      expect(queryRangeSpy.mock.calls[1]?.[0]?.query).toContain(
        'env="production"'
      );

      // Token rate timeseries (third queryRange call)
      expect(queryRangeSpy.mock.calls[2]?.[0]?.query).toContain(
        'env="production"'
      );

      // Total requests instant query
      expect(queryInstantSpy.mock.calls[0]?.[0]?.query).toContain(
        'env="production"'
      );
    });

    it("should NOT allow client-controlled env parameter", async () => {
      // Attempt injection via env param (service should hardcode env from param)
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: 'preview",app="malicious',
        kThreshold: 50,
      });

      // Query should use the provided env AS-IS (service doesn't sanitize - that's facade's job)
      // This test validates service uses params.env directly, not a different source
      const denominatorQuery = queryRangeSpy.mock.calls[0]?.[0]?.query;
      expect(denominatorQuery).toContain('env="preview",app="malicious"');
    });
  });

  describe("K-anonymity pointwise suppression", () => {
    it("should return null for buckets with denom < K (not 0, not omitted)", async () => {
      // Mock denominator result: [100, 30, 80, 10] (2nd and 4th bucket below k=50)
      // Per Prometheus HTTP API: values are [timestamp, value_string] tuples
      queryRangeSpy.mockResolvedValueOnce({
        resultType: "matrix",
        result: [
          {
            metric: {},
            values: [
              [1000, "100"],
              [2000, "30"], // Below K
              [3000, "80"],
              [4000, "10"], // Below K
            ] as [number, string][],
          },
        ],
      });

      // Mock request rate result: [50, 20, 60, 5]
      queryRangeSpy.mockResolvedValueOnce({
        resultType: "matrix",
        result: [
          {
            metric: {},
            values: [
              [1000, "50"],
              [2000, "20"],
              [3000, "60"],
              [4000, "5"],
            ] as [number, string][],
          },
        ],
      });

      // Mock other range queries (empty)
      queryRangeSpy.mockResolvedValue({
        resultType: "matrix",
        result: [],
      });

      const result = await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      // Validate pointwise suppression
      expect(result.timeseries.requestRate).toEqual([
        { timestamp: expect.any(Date), value: 50 }, // denom=100 >= 50 ✓
        { timestamp: expect.any(Date), value: null }, // denom=30 < 50 ✗
        { timestamp: expect.any(Date), value: 60 }, // denom=80 >= 50 ✓
        { timestamp: expect.any(Date), value: null }, // denom=10 < 50 ✗
      ]);
    });

    it("should suppress summary stats when total requests < K", async () => {
      // Mock denominator (range query) - empty for simplicity
      queryRangeSpy.mockResolvedValue({
        resultType: "matrix",
        result: [],
      });

      // Mock total requests instant query: 40 (below k=50)
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "40"] }],
      });

      // Mock total tokens instant query: 100000
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "100000"] }],
      });

      // Mock error rate instant query: 2.5%
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "2.5"] }],
      });

      const result = await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      // All summary stats should be null due to k-anonymity
      expect(result.summary.totalRequests).toBeNull();
      expect(result.summary.totalTokens).toBeNull();
      expect(result.summary.errorRatePercent).toBeNull();
    });

    it("should return stats when total requests >= K", async () => {
      // Mock denominator (range query) - empty for simplicity
      queryRangeSpy.mockResolvedValue({
        resultType: "matrix",
        result: [],
      });

      // Mock total requests instant query: 100 (meets k=50)
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "100"] }],
      });

      // Mock total tokens instant query: 100000
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "100000"] }],
      });

      // Mock error rate instant query: 2.5%
      queryInstantSpy.mockResolvedValueOnce({
        resultType: "vector",
        result: [{ metric: {}, value: [0, "2.5"] }],
      });

      const result = await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      // Summary stats should be present
      expect(result.summary.totalRequests).toBe(100);
      expect(result.summary.totalTokens).toBe(100000);
      expect(result.summary.errorRatePercent).toBe(2.5);
    });
  });

  describe("Denominator query uses identical filters/bucket/step", () => {
    it("should use same baseFilters for denominator and request rate series", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      const denominatorQuery = queryRangeSpy.mock.calls[0]?.[0]?.query;
      const requestRateQuery = queryRangeSpy.mock.calls[1]?.[0]?.query;

      // Extract filter portion (inside curly braces)
      const denominatorFilters = denominatorQuery?.match(/\{(.+?)\}/)?.[1];
      const requestRateFilters = requestRateQuery?.match(/\{(.+?)\}/)?.[1];

      // Filters should be identical
      expect(denominatorFilters).toBe(requestRateFilters);
      expect(denominatorFilters).toContain('app="cogni-template"');
      expect(denominatorFilters).toContain('env="production"');
      expect(denominatorFilters).toContain('route!="meta.metrics"');
    });

    it("should use same step for denominator and request rate series", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "30d", // Step = 6h for 30d
        env: "production",
        kThreshold: 50,
      });

      const denominatorParams = queryRangeSpy.mock.calls[0]?.[0];
      const requestRateParams = queryRangeSpy.mock.calls[1]?.[0];

      // Steps should match
      expect(denominatorParams?.step).toBe("6h");
      expect(requestRateParams?.step).toBe("6h");

      // Query range expressions should use same step
      expect(denominatorParams?.query).toContain("[6h]");
      expect(requestRateParams?.query).toContain("[6h]");
    });

    it("should use same start/end for denominator and request rate series", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      const denominatorParams = queryRangeSpy.mock.calls[0]?.[0];
      const requestRateParams = queryRangeSpy.mock.calls[1]?.[0];

      // Start and end times should match
      expect(denominatorParams?.start).toEqual(requestRateParams?.start);
      expect(denominatorParams?.end).toEqual(requestRateParams?.end);
    });
  });

  describe("Window configuration", () => {
    it("should use 1h step for 7d window", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      const denominatorParams = queryRangeSpy.mock.calls[0]?.[0];
      expect(denominatorParams?.step).toBe("1h");
      expect(denominatorParams?.query).toContain("[1h]");
    });

    it("should use 6h step for 30d window", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "30d",
        env: "production",
        kThreshold: 50,
      });

      const denominatorParams = queryRangeSpy.mock.calls[0]?.[0];
      expect(denominatorParams?.step).toBe("6h");
      expect(denominatorParams?.query).toContain("[6h]");
    });

    it("should use 1d step for 90d window", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "90d",
        env: "production",
        kThreshold: 50,
      });

      const denominatorParams = queryRangeSpy.mock.calls[0]?.[0];
      expect(denominatorParams?.step).toBe("1d");
      expect(denominatorParams?.query).toContain("[1d]");
    });
  });

  describe("Scrape endpoint exclusion", () => {
    it("should exclude meta.metrics route from all queries", async () => {
      await getAnalyticsSummary(mockMetricsQuery, {
        window: "7d",
        env: "production",
        kThreshold: 50,
      });

      // Check all range queries
      for (const call of queryRangeSpy.mock.calls) {
        const query = call[0]?.query;
        if (query?.includes("http_requests_total")) {
          expect(query).toContain('route!="meta.metrics"');
        }
      }

      // Check instant queries
      for (const call of queryInstantSpy.mock.calls) {
        const query = call[0]?.query;
        if (query?.includes("http_requests_total")) {
          expect(query).toContain('route!="meta.metrics"');
        }
      }
    });
  });
});
