// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/metrics/mimir.adapter`
 * Purpose: Unit tests for Mimir adapter with mocked HTTP calls.
 * Scope: Tests auth headers, timeout handling, error mapping. Does NOT test real Mimir service.
 * Invariants: No real HTTP calls; deterministic responses; validates MetricsQueryPort contract compliance.
 * Side-effects: none (mocked fetch)
 * Notes: Tests Basic auth encoding, timeout abort, HTTP error handling.
 * Links: src/adapters/server/metrics/mimir.adapter.ts, MetricsQueryPort port
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MimirAdapterConfig,
  MimirMetricsAdapter,
} from "@/adapters/server/metrics/mimir.adapter";
import { reconcileReliabilityContainment } from "@/features/nodes/reliability-status";
import type { DatabaseContainmentPort } from "@/ports";

describe("MimirMetricsAdapter", () => {
  let adapter: MimirMetricsAdapter;
  let mockFetch: ReturnType<typeof vi.fn>;

  const testConfig: MimirAdapterConfig = {
    url: "https://mimir.example.com",
    username: "test-user",
    password: "test-password",
    timeoutMs: 1000,
  };

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
    adapter = new MimirMetricsAdapter(testConfig);
    vi.clearAllMocks();
  });

  describe("Basic auth header", () => {
    it("should send correct Basic auth header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "matrix",
            result: [],
          },
        }),
      });

      await adapter.queryRange({
        query: "up",
        start: new Date(),
        end: new Date(),
        step: "1h",
      });

      // Extract Authorization header from fetch call
      const fetchCall = mockFetch.mock.calls[0];
      const headers = fetchCall?.[1]?.headers;
      const authHeader = headers?.Authorization;

      // Verify Basic auth header format
      expect(authHeader).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

      // Verify correct credentials (base64 decoded)
      const base64Credentials = authHeader.replace("Basic ", "");
      const decodedCredentials = Buffer.from(
        base64Credentials,
        "base64"
      ).toString("utf8");
      expect(decodedCredentials).toBe("test-user:test-password");
    });

    it("should include Accept: application/json header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "matrix",
            result: [],
          },
        }),
      });

      await adapter.queryRange({
        query: "up",
        start: new Date(),
        end: new Date(),
        step: "1h",
      });

      const fetchCall = mockFetch.mock.calls[0];
      const headers = fetchCall?.[1]?.headers;
      expect(headers?.Accept).toBe("application/json");
    });
  });

  it("reports exact node-attributed critical evidence without mutating admission", async () => {
    const vector = (result: unknown[]) => ({
      ok: true,
      json: async () => ({
        status: "success",
        data: { resultType: "vector", result },
      }),
    });
    const now = Date.now() / 1000;
    const labels = {
      environment: "candidate-a",
      node_slug: "red",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: "a".repeat(32),
    };
    mockFetch
      .mockResolvedValueOnce(
        vector([
          { metric: { probe: "Frankfurt" }, value: [now, "1"] },
          { metric: { probe: "Ohio" }, value: [now, "1"] },
        ])
      )
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "20"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "70"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "80"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "75"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "41"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "42"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "43"] }]));
    mockFetch.mockImplementation(async () =>
      vector([{ metric: labels, value: [now, String(now)] }])
    );

    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => ({
        nodeId: "921b1d1d-4ded-4a6d-b3f1-f7d6affa406a",
        nodeSlug: "red",
        environment: "candidate-a",
        desiredTier: "shared",
        budgetProfile: "shared-default-v1",
        contained: false,
        phase: "open",
        activeSessions: 0,
        rolesCanLogin: true,
        firewallFenced: false,
        cell: null,
        observedAt: new Date().toISOString(),
        lastTransitionAt: null,
        incidentId: null,
        reason: null,
      }),
      contain: async (action) => {
        actions.push(action);
        return {
          nodeId: action.nodeId,
          nodeSlug: action.nodeSlug,
          environment: action.environment,
          desiredTier: action.desiredTier,
          budgetProfile: action.budgetProfile,
          contained: true,
          phase: "contained",
          activeSessions: 0,
          rolesCanLogin: false,
          firewallFenced: false,
          cell: null,
          observedAt: new Date().toISOString(),
          lastTransitionAt: new Date().toISOString(),
          incidentId: action.incidentId,
          reason: action.reason,
        };
      },
      readmit: async () => {
        throw new Error("not used");
      },
    };
    const buildSha = "0123456789abcdef0123456789abcdef01234567";
    const status = await reconcileReliabilityContainment(
      {
        nodeId: "921b1d1d-4ded-4a6d-b3f1-f7d6affa406a",
        slug: "red",
        environment: "candidate-a",
        buildSha,
        sourceSha: buildSha,
        substrateHost: "a".repeat(32),
        desiredTier: "shared",
        budgetProfile: "shared-default-v1",
        incidentId: "realistic-mimir-fixture",
      },
      { metrics: adapter, containment }
    );

    expect(status).toMatchObject({
      state: "warning",
      incidentReason: "I/O pressure critical",
      utilization: {
        evidenceScope: "node",
        databaseShare5m: {
          backendsPct: 41,
          physicalReadsPct: 42,
          tempBytesPct: 43,
        },
      },
    });
    expect(actions).toEqual([]);
    expect(mockFetch.mock.calls.slice(5).map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cogni_reliability_v1_database"),
        expect.stringContaining("node_slug%3D%22red%22"),
      ])
    );
  });

  it("refuses containment when a critical signal and its attribution are skewed", async () => {
    const vector = (result: unknown[]) => ({
      ok: true,
      json: async () => ({
        status: "success",
        data: { resultType: "vector", result },
      }),
    });
    const now = Date.now() / 1000;
    const staleButTtlFresh = now - 90;
    const labels = {
      environment: "candidate-a",
      node_slug: "red",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: "a".repeat(32),
    };
    mockFetch
      .mockResolvedValueOnce(vector([]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "25"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "20"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "80"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "75"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "10"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "60"] }]))
      .mockResolvedValueOnce(vector([{ metric: labels, value: [now, "60"] }]));
    mockFetch.mockImplementation(async (url) =>
      vector([
        {
          metric: labels,
          value: [
            now,
            String(
              new URL(url).searchParams
                .get("query")
                ?.includes("physical_reads") ||
                new URL(url).searchParams.get("query")?.includes("temp_bytes")
                ? staleButTtlFresh
                : now
            ),
          ],
        },
      ])
    );

    const snapshot = await adapter.queryReliabilitySnapshot({
      environment: "candidate-a",
      nodeSlug: "red",
      substrateHost: "a".repeat(32),
      databaseTier: "shared",
      budgetProfile: "shared-default-v1",
    });

    expect(snapshot).toMatchObject({
      evidenceScope: "environment-shared",
      ioPressurePct: null,
      databaseShare5m: {
        physicalReadsPct: null,
        tempBytesPct: null,
      },
    });
  });

  it("refuses node attribution from another physical host in the same environment", async () => {
    const now = Date.now() / 1000;
    const labels = {
      environment: "candidate-a",
      node_slug: "operator",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: "b".repeat(32),
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: labels, value: [now, "90"] }],
        },
      }),
    });
    const snapshot = await adapter.queryReliabilitySnapshot({
      environment: "candidate-a",
      nodeSlug: "operator",
      databaseTier: "shared",
      budgetProfile: "shared-default-v1",
      substrateHost: "a".repeat(32),
    });
    expect(snapshot).toMatchObject({
      evidenceScope: "environment-shared",
      ioPressurePct: null,
      databaseShare5m: {
        backendsPct: null,
        physicalReadsPct: null,
        tempBytesPct: null,
      },
    });
  });

  it("rejects fresh query evaluation timestamps over stale recording samples", async () => {
    const evaluatedAt = Date.now() / 1000;
    const labels = {
      environment: "candidate-a",
      node_slug: "operator",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: "a".repeat(32),
    };
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: labels,
              value: [
                evaluatedAt,
                new URL(url).searchParams.get("query")?.startsWith("timestamp(")
                  ? String(evaluatedAt - 180)
                  : "90",
              ],
            },
          ],
        },
      }),
    }));
    const snapshot = await adapter.queryReliabilitySnapshot({
      environment: "candidate-a",
      nodeSlug: "operator",
      databaseTier: "shared",
      budgetProfile: "shared-default-v1",
      substrateHost: "a".repeat(32),
    });
    expect(snapshot).toMatchObject({
      evidenceScope: "environment-shared",
      ioPressurePct: null,
      connectionPct: null,
      databaseShare5m: {
        physicalReadsPct: null,
        tempBytesPct: null,
        backendsPct: null,
      },
    });
    expect(
      new Set(
        mockFetch.mock.calls.map(([url]) =>
          new URL(url).searchParams.get("time")
        )
      ).size
    ).toBe(1);
  });

  describe("route reads without an actuator probe binding (bug.5519)", () => {
    const sharedHost = "9e8bb1a5190947e7b7a29f5d1a0d4f71";
    const recorded = (host: string) => ({
      environment: "production",
      node_slug: "red",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: host,
    });
    const prodLike = (hosts: readonly string[]) => (url: string) => {
      const params = new URL(url).searchParams;
      const query = params.get("query") ?? "";
      // Stamp with the adapter's fixed evaluation instant, never wall clock.
      const now = Number(params.get("time"));
      const result = query.includes("probe_success")
        ? [
            { metric: { probe: "Frankfurt" }, value: [now, "0"] },
            { metric: { probe: "Ohio" }, value: [now, "1"] },
          ]
        : hosts.map((host) => ({
            metric: recorded(host),
            value: [now, query.startsWith("timestamp(") ? String(now) : "60"],
          }));
      return {
        ok: true,
        json: async () => ({
          status: "success",
          data: { resultType: "vector", result },
        }),
      };
    };

    it("attributes the environment's single recorded substrate host instead of matching a literal 'unknown'", async () => {
      mockFetch.mockImplementation(async (url) => prodLike([sharedHost])(url));
      const snapshot = await adapter.queryReliabilitySnapshot({
        environment: "production",
        nodeSlug: "red",
        databaseTier: "shared",
        budgetProfile: "shared-default-v1",
      });

      const queries = mockFetch.mock.calls.map(
        ([url]) => new URL(url).searchParams.get("query") ?? ""
      );
      expect(queries.some((q) => q.includes('substrate_host="unknown"'))).toBe(
        false
      );
      expect(snapshot.regionalReadiness).toEqual([
        expect.objectContaining({ region: "Frankfurt", healthy: false }),
        expect.objectContaining({ region: "Ohio", healthy: true }),
      ]);
      expect(snapshot).toMatchObject({
        ioPressurePct: 60,
        connectionPct: 60,
        memoryHeadroomPct: 60,
        diskHeadroomPct: 60,
      });
    });

    it("fails closed when the unbound read observes more than one physical host", async () => {
      mockFetch.mockImplementation(async (url) =>
        prodLike([sharedHost, "b".repeat(32)])(url)
      );
      const snapshot = await adapter.queryReliabilitySnapshot({
        environment: "production",
        nodeSlug: "red",
        databaseTier: "shared",
        budgetProfile: "shared-default-v1",
      });
      expect(snapshot.regionalReadiness).toHaveLength(2);
      expect(snapshot).toMatchObject({
        evidenceScope: "environment-shared",
        ioPressurePct: null,
        connectionPct: null,
        memoryHeadroomPct: null,
        diskHeadroomPct: null,
      });
    });
  });

  it("rejects a source timestamp receipt whose physical host differs from its signal", async () => {
    const evaluatedAt = Date.now() / 1000;
    const labels = {
      environment: "candidate-a",
      node_slug: "operator",
      database_tier: "shared",
      budget_profile: "shared-default-v1",
      policy_version: "reliability-status-v1",
      substrate_host: "a".repeat(32),
    };
    mockFetch.mockImplementation(async (url) => {
      const source = new URL(url).searchParams
        .get("query")
        ?.startsWith("timestamp(");
      return {
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: {
                  ...labels,
                  substrate_host: source
                    ? "b".repeat(32)
                    : labels.substrate_host,
                },
                value: [evaluatedAt, source ? String(evaluatedAt) : "90"],
              },
            ],
          },
        }),
      };
    });
    expect(
      await adapter.queryReliabilitySnapshot({
        environment: "candidate-a",
        nodeSlug: "operator",
        databaseTier: "shared",
        budgetProfile: "shared-default-v1",
        substrateHost: "a".repeat(32),
      })
    ).toMatchObject({
      evidenceScope: "environment-shared",
      ioPressurePct: null,
    });
  });

  describe("Timeout handling", () => {
    it("should abort request on timeout", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";

      mockFetch.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          // Simulate timeout abort
          setTimeout(() => reject(abortError), 50);
        });
      });

      const shortTimeoutAdapter = new MimirMetricsAdapter({
        ...testConfig,
        timeoutMs: 100,
      });

      await expect(
        shortTimeoutAdapter.queryRange({
          query: "up",
          start: new Date(),
          end: new Date(),
          step: "1h",
        })
      ).rejects.toThrow("Mimir query timeout after 100ms");
    });

    it("should pass AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "matrix",
            result: [],
          },
        }),
      });

      await adapter.queryRange({
        query: "up",
        start: new Date(),
        end: new Date(),
        step: "1h",
      });

      const fetchCall = mockFetch.mock.calls[0];
      const signal = fetchCall?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("HTTP error handling", () => {
    it("should throw on non-200 HTTP status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
      });

      await expect(
        adapter.queryRange({
          query: "up",
          start: new Date(),
          end: new Date(),
          step: "1h",
        })
      ).rejects.toThrow("Mimir query failed: 500 Internal Server Error");
    });

    it("should throw on Prometheus error status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "error",
          error: "invalid query syntax",
          errorType: "bad_data",
        }),
      });

      await expect(
        adapter.queryRange({
          query: "invalid{",
          start: new Date(),
          end: new Date(),
          step: "1h",
        })
      ).rejects.toThrow("Mimir query error: invalid query syntax");
    });

    it("should handle JSON parse failures gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("JSON parse error");
        },
      });

      await expect(
        adapter.queryRange({
          query: "up",
          start: new Date(),
          end: new Date(),
          step: "1h",
        })
      ).rejects.toThrow("JSON parse error");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(
        adapter.queryRange({
          query: "up",
          start: new Date(),
          end: new Date(),
          step: "1h",
        })
      ).rejects.toThrow("Network error");
    });

    it("should not leak credentials in error messages", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection failed"));

      try {
        await adapter.queryRange({
          query: "up",
          start: new Date(),
          end: new Date(),
          step: "1h",
        });
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).not.toContain("test-password");
        expect(errorMessage).not.toContain("test-user");
      }
    });
  });

  describe("queryRange", () => {
    it("should construct correct query_range URL with parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "matrix",
            result: [],
          },
        }),
      });

      const start = new Date("2025-01-01T00:00:00Z");
      const end = new Date("2025-01-01T01:00:00Z");

      await adapter.queryRange({
        query: "up",
        start,
        end,
        step: "5m",
      });

      const fetchCall = mockFetch.mock.calls[0];
      const url = new URL(fetchCall?.[0]);

      expect(url.pathname).toBe("/api/v1/query_range");
      expect(url.searchParams.get("query")).toBe("up");
      expect(url.searchParams.get("start")).toBe(
        Math.floor(start.getTime() / 1000).toString()
      );
      expect(url.searchParams.get("end")).toBe(
        Math.floor(end.getTime() / 1000).toString()
      );
      expect(url.searchParams.get("step")).toBe("5m");
    });

    it("should return parsed matrix result", async () => {
      const mockData = {
        resultType: "matrix",
        result: [
          {
            metric: { job: "test" },
            values: [
              [1000, "1"],
              [2000, "2"],
            ] as [number, string][],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: mockData,
        }),
      });

      const result = await adapter.queryRange({
        query: "up",
        start: new Date(),
        end: new Date(),
        step: "1h",
      });

      expect(result).toEqual(mockData);
    });
  });

  describe("queryInstant", () => {
    it("should construct correct query URL with time parameter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "vector",
            result: [],
          },
        }),
      });

      const time = new Date("2025-01-01T12:00:00Z");

      await adapter.queryInstant({
        query: "up",
        time,
      });

      const fetchCall = mockFetch.mock.calls[0];
      const url = new URL(fetchCall?.[0]);

      expect(url.pathname).toBe("/api/v1/query");
      expect(url.searchParams.get("query")).toBe("up");
      expect(url.searchParams.get("time")).toBe(
        Math.floor(time.getTime() / 1000).toString()
      );
    });

    it("should omit time parameter when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "vector",
            result: [],
          },
        }),
      });

      await adapter.queryInstant({
        query: "up",
      });

      const fetchCall = mockFetch.mock.calls[0];
      const url = new URL(fetchCall?.[0]);

      expect(url.searchParams.get("time")).toBeNull();
    });

    it("should return parsed vector result", async () => {
      const mockData = {
        resultType: "vector",
        result: [
          {
            metric: { job: "test" },
            value: [1609459200, "42"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: mockData,
        }),
      });

      const result = await adapter.queryInstant({
        query: "up",
      });

      expect(result).toEqual(mockData);
    });
  });

  describe("queryTemplate", () => {
    it("should throw UNKNOWN_TEMPLATE error for invalid template", async () => {
      const { TemplateQueryError } = await import(
        "@/adapters/server/metrics/mimir.adapter"
      );

      try {
        await adapter.queryTemplate({
          template: "nonexistent_template" as never,
          service: "cogni-template",
          environment: "production",
          window: "5m",
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateQueryError);
        expect((error as InstanceType<typeof TemplateQueryError>).code).toBe(
          "UNKNOWN_TEMPLATE"
        );
      }
    });

    it("should generate deterministic queryRef and enforce maxPoints", async () => {
      // Mock successful range query with many points (Prometheus tuple format)
      const manyPoints: [number, string][] = Array.from(
        { length: 150 },
        (_, i) => [1000 + i * 60, String(i)]
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              { metric: { service: "cogni-template" }, values: manyPoints },
            ],
          },
        }),
      });

      const params = {
        template: "request_rate" as const,
        service: "cogni-template",
        environment: "production" as const,
        window: "5m" as const,
      };

      // Call twice with same params
      const result1 = await adapter.queryTemplate(params);
      const result2 = await adapter.queryTemplate(params);

      // queryRef should be deterministic (same for same inputs in same minute)
      expect(result1.queryRef).toMatch(/^mqt_[a-f0-9]{12}$/);
      expect(result1.queryRef).toBe(result2.queryRef);

      // maxPoints enforcement: 150 input points should be truncated to 100
      expect(result1.series.length).toBeLessThanOrEqual(100);
      expect(result1.truncated).toBe(true);
    });
  });
});
