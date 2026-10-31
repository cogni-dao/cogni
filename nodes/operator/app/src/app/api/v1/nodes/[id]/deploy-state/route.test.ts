// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/deploy-state` (test)
 * Purpose: Pin the money-loop read extension (story.5039 PR-B, reshaped by task.5138) — the
 *   deploy view carries this node's live paid-lease receipts plus the orphan diff, with closure
 *   honestly "unknown" (the app holds no Console key; authoritative closure proof is in-actuator,
 *   bug.5189), OMITS the block (never fabricates an empty one) when the lease capability is
 *   unwired, and degrades the same way when the ledger read fails.
 * Scope: Unit tests over mocked session/authz/container — no IO.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/deploy-state/route.ts, bug.5189, task.5138
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const getDeployState = vi.fn();
const listAllocated = vi.fn();
const listReceipts = vi.fn();
const read = vi.fn();
const readNativeStates = vi.fn();

const NODE = { nodeId: "123e4567-e89b-12d3-a456-426614174001", slug: "blue" };

const container: {
  deployCapability: unknown;
  leaseReadCapability: unknown;
} = { deployCapability: undefined, leaseReadCapability: undefined };

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: authorize,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => container,
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ deployEnvs: ["candidate-a"] }],
        }),
      }),
    }),
  }),
}));
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: () => undefined }));
vi.mock("@/features/nodes/flight-status", () => ({
  FLIGHT_ENVS: ["candidate-a"],
}));
vi.mock("@/features/nodes/node-lookup", () => ({ nodeIdOrSlug: () => ({}) }));
vi.mock("@/shared/db/nodes", () => ({ nodes: {} }));
vi.mock("@/shared/observability", () => ({
  createRequestContext: () => ({
    reqId: "req-1",
    routeId: "nodes.deploy-state",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
  EVENT_NAMES: {
    NODE_DEPLOY_STATE_COMPLETE: "feature.node_deploy_state.complete",
  },
  logEvent: vi.fn(),
  makeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const DEPLOY_CELL = {
  env: "candidate-a",
  node: "blue",
  sourceSha: null,
  digest: null,
  buildSha: null,
  health: "healthy" as const,
  replicas: { desired: 1, ready: 1 },
};

const receiptOf = (environment: string, externalName: string) => ({
  receiptId: `r-${externalName}`,
  cogniKey: `xcw:cogni-${environment}-blue:blue:0`,
  identity: {
    nodeId: NODE.nodeId,
    compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
    compositeGeneration: 0,
  },
  environment,
  state: "allocated",
  externalName,
});

const get = async (query = ""): Promise<Response> => {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `https://operator.example/api/v1/nodes/${NODE.nodeId}/deploy-state${query}`
    ),
    { params: Promise.resolve({ id: NODE.nodeId }) }
  );
};

describe("GET /api/v1/nodes/[id]/deploy-state — lease read (story.5039 PR-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true, node: NODE });
    getDeployState.mockResolvedValue(DEPLOY_CELL);
    container.deployCapability = { getDeployState };
    container.leaseReadCapability = {
      listAllocated,
      listReceipts,
      read,
      readNativeStates,
    };
    listAllocated.mockResolvedValue([]);
    listReceipts.mockResolvedValue([]);
    read.mockResolvedValue(null);
    readNativeStates.mockResolvedValue({});
  });

  it("returns leases with closure 'unknown' (no app-side Console read-back) AND the orphan diff", async () => {
    // One declared lease (candidate-a) still billing, one lease on an env the catalog no
    // longer declares (preview) — the undetectable orphan the unfiltered enumeration exists for.
    // Closure is honestly "unknown" for BOTH: the app holds no Console key (task.5138,
    // ONE_CONSOLE_KEY_PER_ACCOUNT) — the authoritative closure proof lives in-actuator (bug.5189).
    listAllocated.mockResolvedValue([
      receiptOf("candidate-a", "7001"),
      receiptOf("preview", "7002"),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Unfiltered by env — the orphan can only surface from the node-wide enumeration.
    expect(listAllocated).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE.nodeId })
    );
    expect(body.leases).toEqual([
      {
        environment: "candidate-a",
        cogniKey: "xcw:cogni-candidate-a-blue:blue:0",
        state: "allocated",
        externalName: "7001",
        closure: "unknown",
      },
      {
        environment: "preview",
        cogniKey: "xcw:cogni-preview-blue:blue:0",
        state: "allocated",
        externalName: "7002",
        closure: "unknown",
      },
    ]);
    // (preview, blue) is not in deployEnvs ["candidate-a"] → orphan.
    expect(body.orphans).toEqual([
      expect.objectContaining({ environment: "preview", externalName: "7002" }),
    ]);
  });

  it("OMITS the lease block when the capability is unwired — absent, not an empty lie", async () => {
    container.leaseReadCapability = undefined;
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("leases");
    expect(body).not.toHaveProperty("orphans");
    // The probe-backed half still serves.
    expect(body.liveEnvs).toEqual(["candidate-a"]);
  });

  it("degrades to an omitted block on a ledger read failure — the deploy view must not 500", async () => {
    listAllocated.mockRejectedValue(new Error("ledger unreachable"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("leases");
    expect(body.liveEnvs).toEqual(["candidate-a"]);
  });
});

describe("bug.5556 exact receipt authorization and independent evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true, node: NODE });
    getDeployState.mockResolvedValue(DEPLOY_CELL);
    container.deployCapability = { getDeployState };
    container.leaseReadCapability = {
      listAllocated,
      listReceipts,
      read,
      readNativeStates,
    };
    listAllocated.mockResolvedValue([]);
    listReceipts.mockResolvedValue([]);
    read.mockResolvedValue(null);
    readNativeStates.mockResolvedValue({});
  });

  it("reads an exact key beyond 50 before slow history and queries only its native handle", async () => {
    const exact = {
      ...receiptOf("candidate-a", "9007199254740993"),
      cogniKey: "exact",
    };
    const order: string[] = [];
    let releaseHistory: () => void = () => undefined;
    let enterHistory: () => void = () => undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const historyEntered = new Promise<void>((resolve) => {
      enterHistory = resolve;
    });
    read.mockImplementation(async () => {
      order.push("exact");
      return exact;
    });
    const native = {
      source: "akash-lcd",
      observedAt: "2026-10-31T02:30:00Z",
      deploymentState: "active",
      deploymentCoverage: "complete",
      deploymentObservedAt: "2026-10-31T02:30:00Z",
      leaseStates: [
        {
          id: {
            owner: "akash1owner",
            dseq: exact.externalName,
            gseq: 1,
            oseq: 1,
            provider: "akash1provider",
            bseq: 0,
          },
          state: "reclaiming",
          observedAt: "2026-10-31T02:30:00Z",
        },
      ],
      leaseCoverage: "complete",
      leasePages: [{ observedAt: "2026-10-31T02:30:00Z", count: 1 }],
      errorCode: null,
    };
    readNativeStates.mockImplementation(async () => {
      order.push("native");
      return { [exact.externalName]: native };
    });
    listReceipts.mockImplementation(async () => {
      order.push("history");
      enterHistory();
      await historyGate;
      return Array.from({ length: 51 }, (_, i) => ({
        ...receiptOf("candidate-a", String(i + 1)),
        cogniKey: `old-${i}`,
      }));
    });
    const pending = get("?cogniKey=exact&environment=candidate-a");
    await historyEntered;
    expect(order).toEqual(["exact", "native", "history"]);
    releaseHistory();
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exactReceipt).toMatchObject({
      cogniKey: "exact",
      externalName: "9007199254740993",
      closure: "unknown",
      native,
    });
    expect(body.receiptStates).toHaveLength(50);
    expect(body.receiptCoverage).toMatchObject({
      status: "truncated",
      limit: 50,
    });
    expect(body.exactCoverage).toMatchObject({ status: "complete" });
    expect(read).toHaveBeenCalledWith({ cogniKey: "exact" });
    expect(readNativeStates).toHaveBeenCalledTimes(1);
    expect(readNativeStates).toHaveBeenCalledWith(
      expect.objectContaining({ dseqs: ["9007199254740993"] })
    );
    expect(order.indexOf("native")).toBeLessThan(order.indexOf("history"));
    expect(body.receiptStates[0].native).toMatchObject({
      errorCode: "not_requested",
    });
  });

  it.each([
    "absent",
    "foreign",
    "wrong-env",
  ])("hides %s keys before all native I/O", async (kind) => {
    read.mockResolvedValue(
      kind === "absent"
        ? null
        : {
            ...receiptOf(
              kind === "wrong-env" ? "preview" : "candidate-a",
              "7001"
            ),
            cogniKey: "exact",
            identity: {
              nodeId: kind === "foreign" ? "other-node" : NODE.nodeId,
            },
          }
    );
    const res = await get("?cogniKey=exact&environment=candidate-a");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "key_not_found" });
    expect(readNativeStates).not.toHaveBeenCalled();
    expect(listAllocated).not.toHaveBeenCalled();
    expect(listReceipts).not.toHaveBeenCalled();
  });

  it("keeps authorization ahead of query validation, ledger and native reads", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
    });
    expect((await get("?owner=untrusted")).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(readNativeStates).not.toHaveBeenCalled();
  });

  it.each([
    "?cogniKey=",
    "?environment=garbage",
    "?owner=akash1evil",
    "?dseq=123",
    "?cogniKey=x&cogniKey=y",
  ])("rejects invalid query %s", async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(readNativeStates).not.toHaveBeenCalled();
  });

  it.each([
    "unwired",
    "error",
  ])("returns evidence_unavailable for exact ledger %s", async (kind) => {
    if (kind === "unwired") container.leaseReadCapability = undefined;
    else read.mockRejectedValue(new Error("ledger down"));
    const res = await get("?cogniKey=exact");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence_unavailable" });
    expect(readNativeStates).not.toHaveBeenCalled();
  });

  it("keeps receipt coverage complete when native and legacy reads fail", async () => {
    listAllocated.mockRejectedValue(new Error("legacy unavailable"));
    listReceipts.mockResolvedValue([
      { ...receiptOf("candidate-a", "7001"), state: "released" },
    ]);
    readNativeStates.mockRejectedValue(new Error("native unavailable"));
    const body = await (await get()).json();
    expect(body.receiptCoverage.status).toBe("complete");
    expect(body.legacyCoverage.status).toBe("unknown");
    expect(body.receiptStates[0]).toMatchObject({
      ledgerState: "released",
      closure: "unknown",
      native: { deploymentCoverage: "unknown", leaseCoverage: "unknown" },
    });
    expect(body).not.toHaveProperty("leases");
  });

  it("keeps handle-bearing closure unknown when native deployment and lease are closed", async () => {
    const receipt = receiptOf("candidate-a", "7001");
    listReceipts.mockResolvedValue([
      receipt,
      {
        ...receiptOf("candidate-a", "unused"),
        cogniKey: "handleless-failed",
        externalName: undefined,
        state: "failed",
      },
    ]);
    const observedAt = "2026-10-31T02:30:00.000Z";
    const native = {
      source: "akash-lcd",
      observedAt,
      deploymentState: "closed",
      deploymentCoverage: "complete",
      deploymentObservedAt: observedAt,
      leaseStates: [
        {
          id: {
            owner: "akash1owner",
            dseq: "7001",
            gseq: 1,
            oseq: 1,
            provider: "akash1provider",
            bseq: 0,
          },
          state: "closed",
          observedAt,
        },
      ],
      leaseCoverage: "complete",
      leasePages: [{ observedAt, count: 1 }],
      errorCode: null,
    };
    readNativeStates.mockResolvedValue({ "7001": native });
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.receiptStates).toMatchObject([
      {
        cogniKey: receipt.cogniKey,
        externalName: "7001",
        closure: "unknown",
        native,
      },
      {
        ledgerState: "failed",
        closure: "closed",
        native: { observedAt: null },
      },
    ]);
    expect(readNativeStates).toHaveBeenCalledTimes(1);
    expect(readNativeStates).toHaveBeenCalledWith(
      expect.objectContaining({ dseqs: ["7001"] })
    );
  });

  it("retains allocated legacy truncation and ledger-only failed closure independently", async () => {
    listAllocated.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) =>
        receiptOf("candidate-a", String(i + 1))
      )
    );
    listReceipts.mockResolvedValue([
      {
        ...receiptOf("candidate-a", "unused"),
        externalName: undefined,
        state: "failed",
      },
    ]);
    const body = await (await get()).json();
    expect(body.leases).toHaveLength(50);
    expect(body.legacyCoverage.status).toBe("potentially_truncated");
    expect(body.receiptCoverage.status).toBe("complete");
    expect(body.receiptStates[0]).toMatchObject({
      ledgerState: "failed",
      closure: "closed",
      native: { observedAt: null },
    });
    expect(readNativeStates).not.toHaveBeenCalled();
    expect(listReceipts).toHaveBeenCalledWith({
      nodeId: NODE.nodeId,
      limit: 51,
    });
  });
});
