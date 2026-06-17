// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/node-task.test`
 * Purpose: Unit tests for the task.5029 new-infra primitives — grant↔node binding (M1) + scope
 *   generalization (M2) checker, the route allow-listing schema (M3/SSRF), the fail-closed per-node
 *   principal resolver (G1), and the dispatchNodeTaskActivity security behavior.
 * Scope: Pure-logic + activity-level tests with mocked deps. Full e2e via stack tests.
 * @internal
 */

import {
  graphExecuteScope,
  nodeTaskScope,
  nodeTaskWildcardScope,
  parseNodeTaskScope,
  validateGrantScope,
} from "@cogni/scheduler-core";
import { NodeTaskInputSchema } from "@cogni/temporal-workflows";
import { describe, expect, it, vi } from "vitest";

// Mock @temporalio/activity (mirrors activities.test.ts) so dispatchNodeTaskActivity runs in-process.
vi.mock("@temporalio/activity", () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string, details?: unknown) => {
      const error = new Error(message);
      (error as { type?: string }).type = type;
      (error as { details?: unknown }).details = details;
      (error as { nonRetryable?: boolean }).nonRetryable = true;
      return error;
    },
  },
  activityInfo: () => ({
    workflowExecution: { workflowId: "wf-id", runId: "temporal-run-id" },
  }),
}));

import { createActivities } from "../src/activities/index.js";
import { createFailClosedNodePrincipalResolver } from "../src/adapters/node-principal.js";
import { NodePrincipalUnprovisionedError } from "../src/ports/index.js";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";
const ROUTE = "/api/internal/ops/metrics-ingest";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createActivities>[0]["logger"];

// ── M1 + M2: scope mint + checker ─────────────────────────────────────────────

describe("validateGrantScope (M1 grant↔node + M2 scope generalization)", () => {
  it("accepts an exact node-task scope for the dispatched node", () => {
    const scopes = [nodeTaskScope(NODE_A, ROUTE)];
    expect(
      validateGrantScope(scopes, nodeTaskScope(NODE_A, ROUTE), NODE_A)
    ).toBe("ok");
  });

  it("accepts the node-bound wildcard for any route on its own node", () => {
    const scopes = [nodeTaskWildcardScope(NODE_A)];
    expect(
      validateGrantScope(scopes, nodeTaskScope(NODE_A, "/api/anything"), NODE_A)
    ).toBe("ok");
  });

  it("REJECTS a grant bound to node B when dispatching for node A (M1 security hole closed)", () => {
    // Grant minted for node B's route, but the worker dispatches for node A.
    const scopes = [nodeTaskScope(NODE_B, ROUTE)];
    expect(
      validateGrantScope(scopes, nodeTaskScope(NODE_A, ROUTE), NODE_A)
    ).toBe("node_mismatch");
  });

  it("REJECTS the node-B wildcard when dispatching for node A", () => {
    const scopes = [nodeTaskWildcardScope(NODE_B)];
    expect(
      validateGrantScope(scopes, nodeTaskScope(NODE_A, ROUTE), NODE_A)
    ).toBe("node_mismatch");
  });

  it("scope_mismatch when the node holds no matching task scope", () => {
    const scopes = [graphExecuteScope("langgraph:poet")];
    expect(
      validateGrantScope(scopes, nodeTaskScope(NODE_A, ROUTE), NODE_A)
    ).toBe("scope_mismatch");
  });

  it("graph path: exact graph scope + wildcard both pass; unrelated fails", () => {
    expect(
      validateGrantScope(
        [graphExecuteScope("langgraph:poet")],
        graphExecuteScope("langgraph:poet"),
        NODE_A
      )
    ).toBe("ok");
    expect(
      validateGrantScope(
        ["graph:execute:*"],
        graphExecuteScope("langgraph:poet"),
        NODE_A
      )
    ).toBe("ok");
    expect(
      validateGrantScope(
        [graphExecuteScope("langgraph:other")],
        graphExecuteScope("langgraph:poet"),
        NODE_A
      )
    ).toBe("scope_mismatch");
  });

  it("parseNodeTaskScope round-trips a route containing colons", () => {
    const route = "/api/internal/ops:weird:path";
    const parsed = parseNodeTaskScope(nodeTaskScope(NODE_A, route));
    expect(parsed).toEqual({ nodeId: NODE_A, route });
  });
});

// ── M3 / SSRF: route allow-listing in the input schema ───────────────────────

describe("NodeTaskInputSchema route allow-listing (M3 / SSRF)", () => {
  const base = {
    nodeId: NODE_A,
    payload: {},
    executionGrantId: "33333333-3333-4333-8333-333333333333",
    runKind: "system_scheduled" as const,
    triggerSource: "temporal_schedule",
    scheduleId: "node-task:metrics",
    requestedBy: "44444444-4444-4444-4444-444444444444",
  };

  it("accepts a clean node-relative path", () => {
    expect(
      NodeTaskInputSchema.safeParse({ ...base, route: ROUTE }).success
    ).toBe(true);
  });

  for (const bad of [
    "https://evil.example.com/steal",
    "//evil.example.com/steal",
    "http://localhost/x",
    "api/no-leading-slash",
    "/api/../../etc/passwd",
  ]) {
    it(`rejects foreign/absolute/traversal route: ${bad}`, () => {
      expect(
        NodeTaskInputSchema.safeParse({ ...base, route: bad }).success
      ).toBe(false);
    });
  }

  it("rejects unknown fields (.strict, SINGLE_INPUT_CONTRACT)", () => {
    expect(
      NodeTaskInputSchema.safeParse({ ...base, route: ROUTE, extra: 1 }).success
    ).toBe(false);
  });
});

// ── G1: fail-closed per-node principal resolver ──────────────────────────────

describe("NodePrincipalResolver (G1 fail-closed)", () => {
  it("the stub THROWS NodePrincipalUnprovisionedError for every node (no shared-token fallback)", async () => {
    const resolver = createFailClosedNodePrincipalResolver();
    await expect(resolver.resolve(NODE_A)).rejects.toBeInstanceOf(
      NodePrincipalUnprovisionedError
    );
  });
});

// ── dispatchNodeTaskActivity: security behavior ──────────────────────────────

function makeActivities(overrides?: {
  resolve?: (nodeId: string) => Promise<{ token: string }>;
}) {
  const resolver = overrides?.resolve
    ? { resolve: vi.fn(overrides.resolve) }
    : createFailClosedNodePrincipalResolver();
  return createActivities({
    grantAdapter: {
      validateGrantForScope: vi.fn(),
      validateGrantForGraph: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["grantAdapter"],
    runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
    nodePrincipalResolver: resolver as Parameters<
      typeof createActivities
    >[0]["nodePrincipalResolver"],
    config: {
      nodeEndpoints: new Map([[NODE_A, "http://node-a:3000"]]),
      schedulerApiToken: "shared-token-must-never-be-used-here",
    },
    logger: mockLogger,
  });
}

describe("dispatchNodeTaskActivity", () => {
  it("FAILS CLOSED when the per-node principal is unprovisioned (never falls back to the shared token)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const activities = makeActivities();
    await expect(
      activities.dispatchNodeTaskActivity({
        nodeId: NODE_A,
        route: ROUTE,
        payload: {},
        scheduleId: "node-task:metrics",
        scheduledFor: "2026-01-01T00:00:00.000Z",
      })
    ).rejects.toMatchObject({ type: "node_principal_unprovisioned" });
    // The fail-closed gate must trip BEFORE any HTTP call.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects an absolute/foreign route before resolving any principal (SSRF defense-in-depth)", async () => {
    const resolve = vi.fn(async () => ({ token: "t" }));
    const activities = makeActivities({ resolve });
    await expect(
      activities.dispatchNodeTaskActivity({
        nodeId: NODE_A,
        route: "https://evil.example.com/steal",
        payload: {},
        scheduleId: "s",
        scheduledFor: "2026-01-01T00:00:00.000Z",
      })
    ).rejects.toMatchObject({ type: "INVALID_NODE_ROUTE" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("forwards the Idempotency-Key and per-node token, bound to the node's own host", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    const activities = makeActivities({
      resolve: async () => ({ token: "per-node-token" }),
    });
    const out = await activities.dispatchNodeTaskActivity({
      nodeId: NODE_A,
      route: ROUTE,
      payload: { window: "15m" },
      scheduleId: "node-task:metrics",
      scheduledFor: "2026-01-01T00:00:00.000Z",
    });
    expect(out).toEqual({ ok: true, status: 202 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://node-a:3000${ROUTE}`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer per-node-token");
    expect(headers["Idempotency-Key"]).toBe(
      `${NODE_A}/node-task:metrics/2026-01-01T00:00:00.000Z`
    );
    fetchSpy.mockRestore();
  });
});
