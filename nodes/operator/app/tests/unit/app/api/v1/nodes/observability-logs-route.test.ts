// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/v1/nodes/observability-logs-route`
 * Purpose: Route-level proof of the optional `?workload=` narrowing on the node log-read proxy (task.5490).
 * Scope: Direct GET against the route with mocked identity, registry, authorization and Loki reader.
 * Invariants: a valid workload becomes one narrowing matcher in the query sent to Loki; an invalid
 *   workload and `service=deploy` plus workload are 400 `invalid_query` and never reach Loki.
 * Side-effects: none (mocks).
 * Links: src/app/api/v1/nodes/[id]/observability/logs/route.ts, src/features/nodes/observability-logs.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";
const queryRange = vi.hoisted(() => vi.fn());

vi.mock("@/app/_lib/auth/route-identity", () => ({
  resolveRouteIdentity: async () => ({ ok: true, user: { id: "u1" } }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    authorization: { check: async () => ({ decision: "allow" }) },
  }),
  resolveServiceDb: () => ({}),
}));
vi.mock("@/bootstrap/observability.factory", () => ({
  createLokiReader: () => ({ queryRange }),
}));
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: () => undefined }));
vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: async () => ({ nodeId: NODE, slug: "poly" }),
}));

import { GET } from "@/app/api/v1/nodes/[id]/observability/logs/route";

const call = (qs: string) =>
  GET(
    new Request(
      `http://localhost/api/v1/nodes/poly/observability/logs?env=candidate-a&${qs}`
    ),
    { params: Promise.resolve({ id: "poly" }) }
  );

describe("GET /api/v1/nodes/{id}/observability/logs ?workload=", () => {
  beforeEach(() => {
    queryRange.mockReset();
    queryRange.mockResolvedValue([]);
  });

  it("returns every workload by default and narrows with a valid workload", async () => {
    const all = await call("service=app");
    expect(all.status).toBe(200);
    expect(queryRange.mock.calls[0]?.[0].query).toBe(
      `{env="candidate-a", service="app", node="${NODE}"}`
    );

    const narrowed = await call("service=app&workload=canary");
    expect(narrowed.status).toBe(200);
    expect(queryRange.mock.calls[1]?.[0].query).toBe(
      `{env="candidate-a", service="app", node="${NODE}", workload="canary"}`
    );
  });

  it("rejects an invalid workload with 400 before Loki", async () => {
    const res = await call(
      `service=app&workload=${encodeURIComponent('Bad"}')}`
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query" });
    expect(queryRange).not.toHaveBeenCalled();
  });

  it("rejects service=deploy with a workload (400) before Loki", async () => {
    const res = await call("service=deploy&workload=canary");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query" });
    expect(queryRange).not.toHaveBeenCalled();
  });
});
