// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-reliability-health-route`
 * Purpose: Prove readmission accepts a real human session and rejects an otherwise privileged agent.
 * Scope: Route authorization boundary with injected identity/control-plane fakes; no IO.
 * Side-effects: none
 * Links: task.5247, src/app/api/v1/nodes/[id]/observability/health/route.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentIdentity: vi.fn(),
  humanSession: vi.fn(),
  authorize: vi.fn(),
  readStatus: vi.fn(),
  readmit: vi.fn(),
  localControl: vi.fn(),
  container: vi.fn(),
  placement: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: mocks.agentIdentity,
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: mocks.humanSession,
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: mocks.authorize,
}));
vi.mock("@/bootstrap/container", () => ({
  resolveLocalReliabilityControl: () => mocks.localControl(),
  getContainer: () => mocks.container(),
  resolveDatabasePlacementResolver: () => ({ resolve: mocks.placement }),
}));
vi.mock("@/features/nodes/reliability-status", () => ({
  readReliabilityStatus: vi.fn(),
}));

import { GET, POST } from "@/app/api/v1/nodes/[id]/observability/health/route";
import { readReliabilityStatus } from "@/features/nodes/reliability-status";

const nodeId = "11111111-1111-4111-8111-111111111111";
const incidentId = `reliability.v1:candidate-a:${nodeId}:1234`;

function request(headers: Record<string, string>, extra: object = {}) {
  return new Request(
    `https://test.cognidao.org/api/v1/nodes/${nodeId}/observability/health`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ env: "candidate-a", ...extra }),
    }
  );
}

describe("human-session reliability readmission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DEPLOY_ENVIRONMENT", "candidate-a");
    // This agent would pass the same node.manage_envs gate as a human.
    mocks.agentIdentity.mockResolvedValue({ id: "privileged-agent" });
    mocks.humanSession.mockResolvedValue(null);
    mocks.localControl.mockReturnValue({
      nodeId: "00000000-0000-4000-8000-000000000001",
      slug: "controller",
    });
    mocks.container.mockReturnValue({
      reliabilityStatusReader: { read: mocks.readStatus },
      reliabilityReadmit: { readmit: mocks.readmit },
    });
    mocks.placement.mockResolvedValue({
      desiredTier: "shared",
      budgetProfile: "shared-default-v1",
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      node: { nodeId, slug: "atlas" },
    });
    mocks.readStatus.mockResolvedValue({ state: "contained", incidentId });
    mocks.readmit.mockResolvedValue({ phase: "open", incidentId });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects a privileged bearer agent before authorization or readmission", async () => {
    const response = await POST(
      request({ authorization: "Bearer cogni_ag_sk_v1_privileged" }),
      { params: Promise.resolve({ id: nodeId }) }
    );

    expect(response.status).toBe(401);
    expect(mocks.agentIdentity).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.readStatus).not.toHaveBeenCalled();
    expect(mocks.readmit).not.toHaveBeenCalled();
  });

  it("ignores spoofed actor and incident fields and attributes the current incident to the human session", async () => {
    mocks.humanSession.mockResolvedValue({ id: "human-user" });
    const response = await POST(
      request(
        { cookie: "session=human" },
        { actorId: "human:spoof", incidentId: "reliability.v1:stale" }
      ),
      { params: Promise.resolve({ id: nodeId }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith({
      id: nodeId,
      userId: "human-user",
      action: "node.manage_envs",
    });
    expect(mocks.readmit).toHaveBeenCalledExactlyOnceWith({
      nodeId,
      nodeSlug: "atlas",
      environment: "candidate-a",
      actorId: "human-user",
      incidentId,
    });
    expect(await response.json()).toEqual({ phase: "open", incidentId });
  });

  it("rejects stale or absent incidents without calling the private readmitter", async () => {
    mocks.humanSession.mockResolvedValue({ id: "human-user" });
    mocks.readStatus.mockResolvedValue({ state: "unknown", incidentId: null });
    const response = await POST(request({ cookie: "session=human" }), {
      params: Promise.resolve({ id: nodeId }),
    });

    expect(response.status).toBe(409);
    expect(mocks.readmit).not.toHaveBeenCalled();
  });

  it("authorizes and readmits the local controller after both ordinary DB roles are fenced", async () => {
    const authorization = { check: vi.fn(async () => ({ decision: "allow" })) };
    mocks.humanSession.mockResolvedValue({ id: "human-user" });
    mocks.container.mockImplementation(() => {
      throw new Error(
        "app/service DB roles NOLOGIN; cold container unavailable"
      );
    });
    mocks.authorize.mockRejectedValue(
      new Error("registry service DB unavailable")
    );
    mocks.localControl.mockReturnValue({
      nodeId,
      slug: "atlas",
      buildSha: "a".repeat(40),
      authorization,
      statusReader: { read: mocks.readStatus },
      readmit: { readmit: mocks.readmit },
    });
    mocks.readmit.mockResolvedValue({
      phase: "recovering",
      incidentId,
      deadlineAt: "2026-10-14T22:10:00.000Z",
    });
    const response = await POST(request({ cookie: "session=human" }), {
      params: Promise.resolve({ id: nodeId }),
    });
    expect(response.status).toBe(202);
    expect(mocks.container).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(authorization.check).toHaveBeenCalledWith({
      actorId: "user:human-user",
      action: "node.manage_envs",
      resource: `node:${nodeId}`,
      context: { tenantId: nodeId, nodeId },
    });
    expect(mocks.readmit).toHaveBeenCalledOnce();
  });

  it("keeps local status fail-closed and readable on a cold request with DB and actuator unavailable", async () => {
    mocks.agentIdentity.mockResolvedValue({ id: "human-user" });
    mocks.container.mockImplementation(() => {
      throw new Error("ordinary DB roles fenced");
    });
    mocks.localControl.mockReturnValue({
      nodeId,
      slug: "atlas",
      buildSha: "a".repeat(40),
      authorization: { check: async () => ({ decision: "allow" }) },
      statusReader: { read: mocks.readStatus },
    });
    mocks.readStatus.mockRejectedValue(new Error("actuator unavailable"));
    const response = await GET(
      new Request(
        `https://test.cognidao.org/api/v1/nodes/${nodeId}/observability/health?env=candidate-a`
      ),
      { params: Promise.resolve({ id: nodeId }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "unknown",
      nodeId,
      buildSha: "a".repeat(40),
    });
    expect(mocks.container).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

describe("node-scoped health for nodes outside the actuator sweep (bug.5519)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const actual = await vi.importActual<
      typeof import("@/features/nodes/reliability-status")
    >("@/features/nodes/reliability-status");
    vi.mocked(readReliabilityStatus).mockImplementation(
      actual.readReliabilityStatus
    );
    mocks.agentIdentity.mockResolvedValue({ id: "node-developer" });
    mocks.localControl.mockReturnValue({
      nodeId: "00000000-0000-4000-8000-000000000001",
      slug: "operator",
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      node: { nodeId, slug: "poly" },
    });
    mocks.placement.mockResolvedValue({
      desiredTier: "dedicated",
      budgetProfile: "dedicated-high-throughput-v1",
    });
    // The actuator answers 503 for every target without a probe binding.
    mocks.readStatus.mockRejectedValue(
      new Error("reliability_status_unavailable")
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reads regional readiness through the governed reliability metrics port while the legacy Basic-auth port is unconfigured", async () => {
    const observedAt = Date.now() / 1000;
    const snapshot = vi.fn(async () => ({
      regionalReadiness: [
        {
          region: "Frankfurt",
          healthy: true,
          observedAt: new Date(observedAt * 1000).toISOString(),
        },
        {
          region: "Ohio",
          healthy: false,
          observedAt: new Date(observedAt * 1000).toISOString(),
        },
      ],
      evidenceScope: "environment-shared" as const,
      ioPressurePct: null,
      connectionPct: null,
      memoryHeadroomPct: null,
      diskHeadroomPct: null,
      databaseShare5m: {
        backendsPct: null,
        physicalReadsPct: null,
        tempBytesPct: null,
      },
      evidenceQueryRefs: ["reliability.v1:production:poly:readiness"],
    }));
    const notConfigured = async () => {
      throw new Error("MetricsQueryPort not configured.");
    };
    mocks.container.mockReturnValue({
      reliabilityStatusReader: { read: mocks.readStatus },
      metricsQuery: {
        queryRange: notConfigured,
        queryInstant: notConfigured,
        queryTemplate: notConfigured,
        queryReliabilitySnapshot: notConfigured,
      },
      reliabilityMetrics: { queryReliabilitySnapshot: snapshot },
    });

    const response = await GET(
      new Request(
        `https://cognidao.org/api/v1/nodes/poly/observability/health?env=production`
      ),
      { params: Promise.resolve({ id: "poly" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ nodeSlug: "poly", environment: "production" })
    );
    expect(body.regionalReadiness).toHaveLength(2);
    expect(body.evidenceQueryRefs).toEqual([
      "reliability.v1:production:poly:readiness",
    ]);
    // No containment evidence or utilization for this node: never green.
    expect(body).toMatchObject({
      state: "unknown",
      incidentReason: "required reliability evidence is missing",
      utilization: { evidenceScope: "environment-shared" },
    });
  });
});
