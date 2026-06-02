// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/metrics-tool.stack`
 * Purpose: Verify core__metrics_query tool executes via real capability injection (no stub).
 * Scope: Tests tool execution through container wiring. Does not test Mimir HTTP transport.
 * Invariants:
 *   - CAPABILITY_INJECTION: Tool receives MetricsCapability from container
 *   - NO_STUB_AT_RUNTIME: Real implementation executes, not stub that throws
 *   - TOOL_BINDING_REQUIRED: All catalog tools have bindings
 * Side-effects: IO (uses FakeMetricsAdapter in test mode)
 * Notes: Requires dev stack running (pnpm dev:stack:test). Uses FakeMetricsAdapter.
 * Links: TOOL_USE_SPEC.md, container.ts, tool-bindings.ts
 * @public
 */

import { createToolAllowlistPolicy, createToolRunner } from "@cogni/ai-core";
import { METRICS_QUERY_NAME } from "@cogni/ai-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getContainer } from "@/bootstrap/container";

describe("[ai] core__metrics_query tool", () => {
  beforeEach(() => {
    // Ensure test mode
    if (process.env.APP_ENV !== "test") {
      throw new Error(
        "This test must run in APP_ENV=test to use FakeMetricsAdapter"
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes via real capability injection, calls metricsCapability.queryTemplate", async () => {
    // Arrange - get toolSource and metricsCapability from container
    const container = getContainer();
    const { toolSource, metricsCapability } = container;

    // Spy on metricsCapability.queryTemplate to prove real capability path
    const queryTemplateSpy = vi.spyOn(metricsCapability, "queryTemplate");

    // Create tool runner with allowlist for metrics query
    const events: unknown[] = [];
    const policy = createToolAllowlistPolicy([METRICS_QUERY_NAME]);
    const toolRunner = createToolRunner(toolSource, (e) => events.push(e), {
      policy,
      ctx: { runId: "test-metrics-tool" },
    });

    const inputParams = {
      template: "request_rate" as const,
      service: "cogni-template",
      environment: "local" as const,
      window: "5m" as const,
    };

    // Act - execute metrics query
    const result = await toolRunner.exec(METRICS_QUERY_NAME, inputParams);

    // Assert - metricsCapability.queryTemplate was called (proves real capability path)
    expect(queryTemplateSpy).toHaveBeenCalledOnce();
    expect(queryTemplateSpy).toHaveBeenCalledWith(inputParams);

    // Assert - tool executed successfully
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("queryRef");
      expect(result.value).toHaveProperty("executedAt");
      expect(result.value).toHaveProperty("summary");
      expect(result.value).toHaveProperty("series");
      expect(result.value).toHaveProperty("truncated");
    }

    // Verify events were emitted
    expect(events.length).toBeGreaterThan(0);
  });

  it("tool exists in toolSource", () => {
    const container = getContainer();
    const { toolSource } = container;

    // Verify tool is available
    expect(toolSource.hasToolId(METRICS_QUERY_NAME)).toBe(true);

    // Verify we can get the bound tool
    const boundTool = toolSource.getBoundTool(METRICS_QUERY_NAME);
    expect(boundTool).toBeDefined();
    expect(boundTool?.id).toBe(METRICS_QUERY_NAME);
  });

  it("all catalog tools have bindings", () => {
    // This test verifies TOOL_BINDING_REQUIRED invariant
    // If any tool is missing a binding, container creation throws
    const container = getContainer();
    const specs = container.toolSource.listToolSpecs();

    // At minimum, we should have core__get_current_time and core__metrics_query
    expect(specs.length).toBeGreaterThanOrEqual(2);

    const toolIds = specs.map((s) => s.name);
    expect(toolIds).toContain("core__get_current_time");
    expect(toolIds).toContain(METRICS_QUERY_NAME);
  });
});
