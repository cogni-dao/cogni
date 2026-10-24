// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-reliability-health-route`
 * Purpose: Prove readmission accepts a real human session and rejects an otherwise privileged agent,
 *   and that every status read emits one terminal health event through the logging wrapper.
 * Scope: Route authorization boundary and log seam with injected identity/control-plane/logger fakes; no IO.
 * Side-effects: none
 * Links: task.5247, bug.5528, src/app/api/v1/nodes/[id]/observability/health/route.ts
 * @internal
 */

import { NextRequest } from "next/server";
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
  logLines: [] as Array<{
    level: string;
    fields: Record<string, unknown>;
    msg?: string | undefined;
  }>,
}));

/** Minimal pino-shaped logger that records merged bindings + fields per line. */
function captureLogger(bindings: Record<string, unknown> = {}): unknown {
  const write =
    (level: string) => (fields: Record<string, unknown>, msg?: string) => {
      mocks.logLines.push({ level, fields: { ...bindings, ...fields }, msg });
    };
  return {
    child: (more: Record<string, unknown>) =>
      captureLogger({ ...bindings, ...more }),
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
  };
}

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
  getRequestLoggingDependencies: () => ({
    log: captureLogger({ nodeId: "operator-self" }),
    clock: { now: () => "2026-10-24T00:00:00.000Z" },
    config: { unhandledErrorPolicy: "rethrow" },
  }),
}));
vi.mock("@/features/nodes/reliability-status", () => ({
  readReliabilityStatus: vi.fn(),
}));

import { GET, POST } from "@/app/api/v1/nodes/[id]/observability/health/route";
import { EVENT_NAMES } from "@/shared/observability";

const nodeId = "11111111-1111-4111-8111-111111111111";
const incidentId = `reliability.v1:candidate-a:${nodeId}:1234`;

function healthEvents() {
  return mocks.logLines.filter(
    (line) =>
      line.fields.event === EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_COMPLETE
  );
}

function request(headers: Record<string, string>, extra: object = {}) {
  return new NextRequest(
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
    mocks.logLines.length = 0;
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
    const response = await GET(healthRequest(), {
      params: Promise.resolve({ id: nodeId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "unknown",
      nodeId,
      buildSha: "a".repeat(40),
    });
    expect(mocks.container).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(healthEvents()).toEqual([
      expect.objectContaining({
        level: "info",
        fields: expect.objectContaining({
          routeId: "nodes.observability.health",
          outcome: "success",
          nodeId,
          environment: "candidate-a",
          state: "unknown",
          regionCount: 0,
          source: "local_fallback",
        }),
      }),
    ]);
  });
});

function healthRequest(headers: Record<string, string> = {}) {
  return new NextRequest(
    `https://test.cognidao.org/api/v1/nodes/${nodeId}/observability/health?env=candidate-a`,
    { headers }
  );
}

describe("reliability status read observability (bug.5528)", () => {
  const actuatorStatus = {
    version: "reliability-status.v1",
    nodeId,
    slug: "atlas",
    environment: "candidate-a",
    buildSha: "b".repeat(40),
    databaseTier: "shared",
    budgetProfile: "shared-default-v1",
    state: "warning",
    regionalReadiness: [
      {
        region: "us-east",
        healthy: true,
        observedAt: "2026-10-24T00:00:00.000Z",
      },
      {
        region: "eu-west",
        healthy: false,
        observedAt: "2026-10-24T00:00:00.000Z",
      },
    ],
    utilization: {
      evidenceScope: "node",
      ioPressurePct: 12,
      connectionPct: 30,
      memoryHeadroomPct: 60,
      diskHeadroomPct: 70,
      databaseShare5m: { backendsPct: 5, physicalReadsPct: 4, tempBytesPct: 0 },
    },
    incidentId: null,
    incidentReason: "secret-free reason never logged",
    observedAt: "2026-10-24T00:00:00.000Z",
    lastTransitionAt: null,
    evidenceQueryRefs: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logLines.length = 0;
    vi.stubEnv("DEPLOY_ENVIRONMENT", "candidate-a");
    mocks.agentIdentity.mockResolvedValue({ id: "agent-user" });
    mocks.localControl.mockReturnValue({
      nodeId: "00000000-0000-4000-8000-000000000001",
      slug: "controller",
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      node: { nodeId, slug: "atlas" },
    });
    mocks.readStatus.mockResolvedValue(actuatorStatus);
    mocks.container.mockReturnValue({
      reliabilityStatusReader: { read: mocks.readStatus },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("logs one terminal event with the routeId, target, state and region count", async () => {
    const response = await GET(healthRequest(), {
      params: Promise.resolve({ id: nodeId }),
    });

    expect(response.status).toBe(200);
    const events = healthEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      msg: EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_COMPLETE,
      fields: {
        routeId: "nodes.observability.health",
        outcome: "success",
        status: 200,
        nodeId,
        environment: "candidate-a",
        state: "warning",
        regionCount: 2,
        source: "actuator",
      },
    });
    expect(events[0]?.fields).not.toHaveProperty("incidentReason");
    // The wrapper's standard envelope carries the same routeId on the request-complete line.
    expect(mocks.logLines).toContainEqual(
      expect.objectContaining({
        msg: "request complete",
        fields: expect.objectContaining({
          route: "nodes.observability.health",
          status: 200,
        }),
      })
    );
  });

  it("keeps the 401 body and logs an unauthorized terminal event", async () => {
    mocks.agentIdentity.mockResolvedValue(null);
    const response = await GET(healthRequest(), {
      params: Promise.resolve({ id: nodeId }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(healthEvents()).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          outcome: "error",
          status: 401,
          errorCode: "unauthorized",
        }),
      }),
    ]);
  });
});
