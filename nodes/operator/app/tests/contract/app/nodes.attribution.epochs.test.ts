// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.attribution.epochs`
 * Purpose: Contract tests for the node-addressable attribution read routes
 *   (`/api/v1/nodes/[id]/attribution/epochs{,/[eid]/contributors,/[eid]/activity}`) — PR C,
 *   story.5023. Proves: a known node the caller is authorized on resolves and returns the same
 *   contract shape as the operator-self twin; an unknown node id → 404; a resolvable node the
 *   caller is NOT authorized on → 403 (cross-node hard-reject); auth is required (401).
 * Scope: Mocks auth + the OpenFGA authorization port + the service-db node resolution + the
 *   attribution store; exercises the real route handlers + shared `epoch-views` helper + Zod
 *   output contracts + the `resolveNodeAndAuthorize` seam. Does not hit a DB.
 * Invariants: AUTH_REQUIRED, NODE_RESOLVED_OR_404, AUTHORIZED_OR_403, SAME_SHAPE_AS_OPERATOR_SELF.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/attribution/epochs/**,
 *   src/features/attribution/read/epoch-views.ts
 * @internal
 */

import {
  epochContributorsOperation,
  listEpochsOperation,
} from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NODE_SLUG = "demo-node";
const EPOCH_ID = "7";

const dbState = vi.hoisted(() => ({
  // The single node row resolveNodeRef selects; null → resolver returns null → 404.
  node: null as { id: string; slug: string } | null,
}));

// OpenFGA authorization port. `resolveNodeAndAuthorize` runs `authorization.check` for
// `node.flight` on the resolved node; `undefined` → 503 authz_unavailable, a non-"allow"
// decision → 403 authz_denied (the cross-node hard-reject). Set `.decision` per test.
const authzState = vi.hoisted(() => ({
  decision: "allow" as "allow" | "deny" | "unavailable",
  check: vi.fn(),
}));

const mockStore = vi.hoisted(() => ({
  listEpochs: vi.fn(),
  getEpoch: vi.fn(),
  getReceiptsForWindow: vi.fn(),
  getReceiptsForEpoch: vi.fn(),
  getSelectionForEpoch: vi.fn(),
  resolveIdentities: vi.fn(),
  updateSelectionUserId: vi.fn(),
}));

const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Minimal drizzle stub: select().from().where().limit() → the node row (or []).
const mockServiceDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => (dbState.node ? [dbState.node] : []),
      }),
    }),
  }),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    attributionStore: mockStore,
    clock: { now: () => "2026-06-30T00:00:00.000Z" },
    config: { unhandledErrorPolicy: "respond_500" },
    log: mockLogger,
    // `undefined` when the test wants the no-authority 503 path; otherwise the port whose
    // `.check` returns the configured decision.
    authorization:
      authzState.decision === "unavailable"
        ? undefined
        : { check: authzState.check },
  }),
  resolveServiceDb: () => mockServiceDb,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

import * as activityHandler from "@/app/api/v1/nodes/[id]/attribution/epochs/[eid]/activity/route";
import * as contributorsHandler from "@/app/api/v1/nodes/[id]/attribution/epochs/[eid]/contributors/route";
import * as epochsHandler from "@/app/api/v1/nodes/[id]/attribution/epochs/route";

const FINALIZED_EPOCH = {
  id: 7n,
  status: "finalized" as const,
  periodStart: new Date("2026-06-01T00:00:00.000Z"),
  periodEnd: new Date("2026-06-08T00:00:00.000Z"),
  weightConfig: { pull_requests: 1, reviews: 2 },
  poolTotalCredits: 10_000n,
  openedAt: new Date("2026-06-01T00:00:00.000Z"),
  closedAt: new Date("2026-06-08T00:00:00.000Z"),
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLogger.child.mockReturnValue(mockLogger);
  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
  dbState.node = { id: NODE_ID, slug: NODE_SLUG };

  // Happy path: the caller is authorized (`node.flight`) on the resolved node. Individual
  // tests flip `authzState.decision` to "deny" to assert the cross-node 403 hard-reject.
  authzState.decision = "allow";
  authzState.check.mockImplementation(async () =>
    authzState.decision === "allow"
      ? { decision: "allow", code: "authz_allowed", checks: [] }
      : { decision: "deny", code: "authz_denied", checks: [] }
  );

  mockStore.listEpochs.mockResolvedValue([FINALIZED_EPOCH]);
  mockStore.getEpoch.mockResolvedValue(FINALIZED_EPOCH);
  mockStore.getReceiptsForWindow.mockResolvedValue([]);
  mockStore.getReceiptsForEpoch.mockResolvedValue([]);
  mockStore.getSelectionForEpoch.mockResolvedValue([]);
  mockStore.resolveIdentities.mockResolvedValue(new Map());
});

describe("GET /api/v1/nodes/[id]/attribution/epochs", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    await testApiHandler({
      appHandler: epochsHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
        expect(mockStore.listEpochs).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 404 for an unknown node id", async () => {
    dbState.node = null;
    await testApiHandler({
      appHandler: epochsHandler,
      params: { id: "00000000-0000-4000-8000-000000000000" },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "node_not_found" });
        expect(mockStore.listEpochs).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 403 when the caller is not authorized on the node (cross-node hard-reject)", async () => {
    // The whole point of PR C's per-node RBAC: a resolvable node the principal has no
    // `node.flight` relation on must NOT leak its epochs. Deny → 403 authz_denied, no store read.
    authzState.decision = "deny";
    await testApiHandler({
      appHandler: epochsHandler,
      params: { id: NODE_SLUG },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "authz_denied" });
        // Authorized on the RESOLVED nodeId (the OpenFGA authority), never the raw slug param.
        expect(authzState.check).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "node.flight",
            resource: `node:${NODE_ID}`,
          })
        );
        expect(mockStore.listEpochs).not.toHaveBeenCalled();
      },
    });
  });

  it("lists the resolved node's epochs (contract-valid, scoped to nodeId)", async () => {
    await testApiHandler({
      appHandler: epochsHandler,
      params: { id: NODE_SLUG },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(() => listEpochsOperation.output.parse(body)).not.toThrow();
        expect(body.total).toBe(1);
        expect(body.epochs[0].id).toBe(EPOCH_ID);
        // Store read is scoped to the RESOLVED nodeId, not the raw slug param.
        expect(mockStore.listEpochs).toHaveBeenCalledWith(NODE_ID);
      },
    });
  });
});

describe("GET /api/v1/nodes/[id]/attribution/epochs/[eid]/contributors", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    await testApiHandler({
      appHandler: contributorsHandler,
      params: { id: NODE_ID, eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
        expect(mockStore.getEpoch).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 404 for an unknown node id", async () => {
    dbState.node = null;
    await testApiHandler({
      appHandler: contributorsHandler,
      params: { id: "00000000-0000-4000-8000-000000000000", eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "node_not_found" });
        expect(mockStore.getEpoch).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 404 for a missing epoch on a known node", async () => {
    mockStore.getEpoch.mockResolvedValue(null);
    await testApiHandler({
      appHandler: contributorsHandler,
      params: { id: NODE_SLUG, eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Epoch not found" });
      },
    });
  });

  it("returns the contributor rollup in the operator-self contract shape, scoped to nodeId", async () => {
    await testApiHandler({
      appHandler: contributorsHandler,
      params: { id: NODE_SLUG, eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(() =>
          epochContributorsOperation.output.parse(body)
        ).not.toThrow();
        expect(body.epochId).toBe(EPOCH_ID);
        expect(body.attributionPipeline).toBe("cogni-v0.0");
        // Both window + epoch-selected reads are scoped to the resolved nodeId.
        expect(mockStore.getReceiptsForWindow).toHaveBeenCalledWith(
          NODE_ID,
          FINALIZED_EPOCH.periodStart,
          FINALIZED_EPOCH.periodEnd
        );
        expect(mockStore.getReceiptsForEpoch).toHaveBeenCalledWith(NODE_ID, 7n);
      },
    });
  });
});

describe("GET /api/v1/nodes/[id]/attribution/epochs/[eid]/activity", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    await testApiHandler({
      appHandler: activityHandler,
      params: { id: NODE_ID, eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
        expect(mockStore.getEpoch).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 404 for an unknown node id", async () => {
    dbState.node = null;
    await testApiHandler({
      appHandler: activityHandler,
      params: { id: "00000000-0000-4000-8000-000000000000", eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "node_not_found" });
        expect(mockStore.getEpoch).not.toHaveBeenCalled();
      },
    });
  });

  it("returns the activity union, echoes the raw epoch id, scoped to nodeId", async () => {
    await testApiHandler({
      appHandler: activityHandler,
      params: { id: NODE_SLUG, eid: EPOCH_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.epochId).toBe(EPOCH_ID);
        expect(body.total).toBe(0);
        expect(body.events).toEqual([]);
        expect(mockStore.getReceiptsForWindow).toHaveBeenCalledWith(
          NODE_ID,
          FINALIZED_EPOCH.periodStart,
          FINALIZED_EPOCH.periodEnd
        );
        expect(mockStore.getReceiptsForEpoch).toHaveBeenCalledWith(NODE_ID, 7n);
      },
    });
  });
});
