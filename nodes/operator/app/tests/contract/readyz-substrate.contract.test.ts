// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-substrate.contract`
 * Purpose: Prove the local-only shallow readiness and explicit deep substrate contract.
 * Scope: Exercises the /readyz route with isolated RPC, Temporal, scheduler-worker, Postgres, Redis, LiteLLM and knowledge-plane probes. Does not perform real network or database IO.
 * Invariants: Default readiness performs zero remote IO; `?deep=1` probes every declared dependency concurrently, returns 503 for any failing one (knowledge plane included, bug.5386), and its body carries `checks`, `unreachable` and `buildSha` for `readDeepReadiness` (story.0029).
 * Side-effects: none
 * Links: src/app/(infra)/readyz/route.ts, Cogni-DAO/cogni#1860
 * @internal
 */

import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mocks = vi.hoisted(() => ({
  getNodeId: vi.fn(),
  assertEvmRpcConfig: vi.fn(),
  getKnowledge: vi.fn(),
  streamLength: vi.fn(),
  fetch: vi.fn(),
  assertRuntimeSecrets: vi.fn(),
  assertSchedulerWorkerConnectivity: vi.fn(),
  assertTemporalConnectivity: vi.fn(),
  checkEvmRpcConnectivity: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  serverEnv: vi.fn(),
  setBuildInfo: vi.fn(),
  verifySystemTenant: vi.fn(),
  warn: vi.fn(),
  getContainer: vi.fn(),
  localRecovery: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveLocalReliabilityControl: () => mocks.localRecovery(),
  getContainer: () =>
    mocks.getContainer() ?? {
      evmOnchainClient: {},
      knowledgeStorePort: { getKnowledge: mocks.getKnowledge },
      runStream: { streamLength: mocks.streamLength },
      paymentRailsActive: false,
      scheduleControl: {},
      serviceAccountService: {},
    },
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) => mocks.verifySystemTenant(...args),
}));

vi.mock("@/shared/config", async (original) => ({
  ...(await original<typeof import("@/shared/config")>()),
  getNodeId: () => mocks.getNodeId(),
}));
vi.mock("@/shared/observability", async (original) => {
  const actual = await original<typeof import("@/shared/observability")>();
  const child = vi.fn();
  const log = {
    debug: vi.fn(),
    error: mocks.error,
    info: mocks.info,
    warn: mocks.warn,
    child,
  };
  child.mockReturnValue(log);
  return { ...actual, makeLogger: () => log };
});

vi.mock("@/shared/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/env")>();
  return {
    ...actual,
    serverEnv: () => mocks.serverEnv(),
  };
});

vi.mock("@/shared/env/invariants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/env/invariants")>();
  return {
    ...actual,
    assertEvmRpcConfig: (...args: unknown[]) =>
      mocks.assertEvmRpcConfig(...args),
    assertRuntimeSecrets: (...args: unknown[]) =>
      mocks.assertRuntimeSecrets(...args),
    assertSchedulerWorkerConnectivity: (...args: unknown[]) =>
      mocks.assertSchedulerWorkerConnectivity(...args),
    assertTemporalConnectivity: (...args: unknown[]) =>
      mocks.assertTemporalConnectivity(...args),
    checkEvmRpcConnectivity: (...args: unknown[]) =>
      mocks.checkEvmRpcConnectivity(...args),
  };
});

vi.mock("@/shared/observability/server/metrics", async (original) => ({
  ...(await original<typeof import("@/shared/observability/server/metrics")>()),
  setBuildInfo: (...args: unknown[]) => mocks.setBuildInfo(...args),
}));

import { readDeepReadiness } from "@cogni/substrate-health";
import { GET } from "@/app/(infra)/readyz/route";
import {
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";

function request(path = "/readyz"): NextRequest {
  return new NextRequest(`http://localhost:3200${path}`);
}

describe("GET /readyz async substrate contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNodeId.mockReturnValue("readyz-test-node");
    mocks.assertEvmRpcConfig.mockReset();
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
      LITELLM_BASE_URL: "http://litellm.test",
      LITELLM_MASTER_KEY: "sk-test",
      DOLTGRES_URL: "postgres://doltgres.test/knowledge",
    });
    mocks.assertTemporalConnectivity.mockResolvedValue(undefined);
    mocks.assertSchedulerWorkerConnectivity.mockResolvedValue(undefined);
    mocks.getKnowledge.mockResolvedValue(null);
    mocks.streamLength.mockResolvedValue(0);
    mocks.fetch.mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ model_name: "m" }] }))
    );
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.checkEvmRpcConnectivity.mockResolvedValue({ ok: true });
    mocks.verifySystemTenant.mockResolvedValue(undefined);
  });

  it("serves scoped recovery through the cold private seam while runtime DB construction is fenced", async () => {
    const sha = "a".repeat(40);
    const evidence = {
      status: "healthy",
      buildSha: sha,
      databaseSystemIdentifier: "123456",
      incidentId: "reliability.v1:incident",
      proofClass: "recovery",
    };
    const read = vi.fn().mockResolvedValue(evidence);
    mocks.getContainer.mockImplementation(() => {
      throw new Error("runtime role NOLOGIN");
    });
    mocks.localRecovery.mockReturnValue({
      nodeId: "12345678-1234-4234-8234-123456789abc",
      slug: "operator",
      buildSha: sha,
      recoveryReader: { read },
    });
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: sha,
      DEPLOY_ENVIRONMENT: "candidate-a",
    });
    const response = await GET(request("/readyz?proof=recovery"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidence);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBuildSha: sha, proofClass: "recovery" })
    );
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
    mocks.getContainer.mockReset();
  });

  it("resolves a remote cell through the private sealed target without runtime DB access or caller SHA", async () => {
    const evidence = {
      status: "healthy",
      buildSha: "b".repeat(40),
      databaseSystemIdentifier: "123456",
      incidentId: "reliability.v1:cell",
      proofClass: "recovery",
    };
    const readBoundTarget = vi.fn().mockResolvedValue(evidence);
    const read = vi.fn();
    mocks.getContainer.mockImplementation(() => {
      throw new Error("runtime role NOLOGIN");
    });
    mocks.localRecovery.mockReturnValue({
      slug: "operator",
      buildSha: "a".repeat(40),
      recoveryReader: { read, readBoundTarget },
    });
    mocks.serverEnv.mockReturnValue({ DEPLOY_ENVIRONMENT: "candidate-a" });
    const response = await GET(
      request("/readyz?proof=recovery&node_slug=fixture")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidence);
    expect(readBoundTarget).toHaveBeenCalledWith({
      nodeSlug: "fixture",
      environment: "candidate-a",
      proofClass: "recovery",
    });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
    mocks.getContainer.mockReset();
  });

  it("rejects unavailable scoped recovery instead of falling back to shallow readiness", async () => {
    mocks.localRecovery.mockReturnValue({ buildSha: "a".repeat(40) });
    const response = await GET(request("/readyz?proof=recovery"));
    expect(response.status).toBe(503);
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("keeps the kubelet probe local-only even when every remote probe would stall", async () => {
    const never = new Promise<never>(() => undefined);
    mocks.checkEvmRpcConnectivity.mockReturnValue(never);
    mocks.assertTemporalConnectivity.mockReturnValue(never);
    mocks.assertSchedulerWorkerConnectivity.mockReturnValue(never);
    mocks.getKnowledge.mockReturnValue(never);
    mocks.streamLength.mockReturnValue(never);
    mocks.verifySystemTenant.mockReturnValue(never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.assertEvmRpcConfig).toHaveBeenCalledOnce();
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertTemporalConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.getKnowledge).not.toHaveBeenCalled();
    expect(mocks.streamLength).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("returns 503 when the mandatory RPC secret is missing", async () => {
    mocks.assertEvmRpcConfig.mockImplementation(() => {
      throw new RuntimeSecretError("EVM_RPC_URL is required");
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "MISSING_RUNTIME_SECRET",
      message: "EVM_RPC_URL is required",
    });
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
  });

  it("forces a live RPC read and returns 503 when the deep probe cannot reach Base", async () => {
    mocks.checkEvmRpcConnectivity.mockResolvedValue({
      ok: false,
      source: "live",
      errorMessage: "RPC timeout",
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "EVM RPC connectivity check failed: RPC timeout",
    });
    expect(mocks.checkEvmRpcConnectivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ APP_ENV: "production" }),
      { forceLive: true }
    );
  });

  it("records successful deep RPC proof", async () => {
    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
  });

  it("does not consult missing async dependencies from shallow readiness", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      buildSha: "readyz-contract-sha",
    });
    expect(mocks.assertTemporalConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("probes every declared dependency concurrently and names each in checks", async () => {
    const response = await GET(request("/readyz?deep=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body.checks)).toEqual([
      "evm-rpc",
      "temporal",
      "scheduler-worker",
      "postgres",
      "redis",
      "litellm-gateway",
      "doltgres",
    ]);
    expect(mocks.getKnowledge).toHaveBeenCalledOnce();
    expect(mocks.streamLength).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://litellm.test/model/info",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      })
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "substrate.deep.complete" }),
      "deep readiness: checks complete"
    );
  });

  it("skips the knowledge plane when DOLTGRES_URL is not declared", async () => {
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      LITELLM_BASE_URL: "http://litellm.test",
      LITELLM_MASTER_KEY: "sk-test",
    });
    const body = await (await GET(request("/readyz?deep=1"))).json();
    expect(body.checks).not.toHaveProperty("doltgres");
    expect(mocks.getKnowledge).not.toHaveBeenCalled();
  });

  it("a failing scheduler-worker does not hide that Postgres answered (story.0029)", async () => {
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker is unavailable",
      unreachable: ["scheduler-worker"],
      buildSha: "readyz-contract-sha",
    });
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce();
    const reading = readDeepReadiness(response.status, body);
    expect(reading.dependencyState("postgres")).toBe("reached");
    expect(reading.dependencyState("scheduler-worker")).toBe("unreached");
  });

  it("names every failing dependency in registry order; reason and message come from the first", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );
    mocks.verifySystemTenant.mockRejectedValue(new Error("pg down"));
    mocks.streamLength.mockRejectedValue(new Error("redis down"));
    mocks.fetch.mockImplementation(
      async () => new Response("{}", { status: 502 })
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "INFRA_UNREACHABLE",
      message: "Temporal is unavailable",
      unreachable: ["temporal", "postgres", "redis", "litellm-gateway"],
    });
  });

  it("returns 503 from the deep probe when the knowledge plane is wedged (bug.5386)", async () => {
    // candidate-flight's verify-candidate once certified a node whose Doltgres
    // plane was unresponsive; deep readiness must refuse, at the budget.
    vi.useFakeTimers();
    mocks.getKnowledge.mockReturnValue(new Promise(() => undefined));

    const pending = GET(request("/readyz?deep=1"));
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    vi.useRealTimers();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      unreachable: ["doltgres"],
      message: "doltgres check exceeded 3000ms budget",
    });
  });

  it("a config 503 carries no deep evidence", async () => {
    mocks.assertRuntimeSecrets.mockImplementationOnce(() => {
      throw new RuntimeSecretError("secret missing");
    });
    const body = await (await GET(request("/readyz?deep=1"))).json();
    expect(body).not.toHaveProperty("unreachable");
    expect(body).not.toHaveProperty("checks");
  });
  it.each([
    "healthy",
    "evm-failed",
    "multiple",
    "timeout",
    "unexpected",
  ] as const)("keeps readiness diagnostics bounded and private: %s", async (scenario) => {
    const sentinel = "READINESS_PRIVATE_SENTINEL";
    if (scenario === "evm-failed" || scenario === "multiple")
      mocks.checkEvmRpcConnectivity.mockResolvedValueOnce({
        ok: false,
        source: "live",
        errorMessage: sentinel,
      });
    if (scenario === "multiple")
      mocks.assertTemporalConnectivity.mockRejectedValueOnce(
        new Error(sentinel)
      );
    if (scenario === "timeout") {
      vi.useFakeTimers();
      mocks.assertTemporalConnectivity.mockReturnValueOnce(
        new Promise(() => {})
      );
    }
    if (scenario === "unexpected")
      mocks.getNodeId.mockImplementationOnce(() => {
        throw new Error(sentinel);
      });
    const pending = GET(request("/readyz?deep=1"));
    if (scenario === "timeout") await vi.advanceTimersByTimeAsync(3001);
    const response = await pending;
    expect(response.status).toBe(
      scenario === "healthy" ? 200 : scenario === "unexpected" ? 500 : 503
    );
    const body = await response.json();
    if (scenario === "unexpected")
      expect(body).toEqual({ status: "error", reason: "INTERNAL_ERROR" });
    else {
      expect(body.checks).toBeDefined();
      if (scenario === "evm-failed" || scenario === "multiple")
        expect(body.unreachable).toContain("evm-rpc");
      if (scenario === "multiple" || scenario === "timeout")
        expect(body.unreachable).toContain("temporal");
    }
    const lines = [
      ...mocks.info.mock.calls,
      ...mocks.error.mock.calls,
      ...mocks.warn.mock.calls,
    ];
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(lines)).not.toContain(sentinel);
    expect(
      lines.filter(([fields]) => fields?.event === "substrate.deep.complete")
    ).toHaveLength(scenario === "unexpected" ? 0 : 1);
    expect(
      lines.filter(([, message]) => message === "request complete")
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it.each([
    "local",
    "construction",
    "logger",
    "context",
    "span",
    "annotation",
    "response",
    "error",
    "summary",
    "build-info",
    "counter",
    "histogram",
    "completion",
    "span-finalizer",
  ] as const)("contains boundary failures without changing resolved readiness: %s", async (phase) => {
    const sentinel = "READINESS_BOUNDARY_PRIVATE_SENTINEL";
    const fail = () => {
      throw new Error(sentinel);
    };
    const obs = await import("@/shared/observability");
    const otel = await import("@/bootstrap/otel");
    if (phase === "local" || phase === "error")
      mocks.serverEnv.mockImplementationOnce(fail);
    if (phase === "construction")
      mocks.getContainer.mockImplementationOnce(fail);
    if (phase === "logger")
      vi.spyOn(obs, "makeLogger").mockImplementationOnce(fail);
    if (phase === "context")
      vi.spyOn(obs, "createRequestContext").mockImplementationOnce(fail);
    if (phase === "span")
      vi.spyOn(otel, "withRootSpan").mockImplementationOnce(fail);
    if (phase === "response")
      vi.spyOn(NextResponse, "json").mockImplementationOnce(fail);
    if (phase === "annotation")
      vi.spyOn(otel, "withRootSpan").mockImplementationOnce(
        async (_name, _attrs, callback) =>
          callback({ traceId: "trace", span: { setAttribute: fail } } as never)
      );
    if (phase === "error") mocks.error.mockImplementationOnce(fail);
    if (phase === "summary") mocks.info.mockImplementationOnce(fail);
    if (phase === "build-info") mocks.setBuildInfo.mockImplementationOnce(fail);
    if (phase === "counter")
      vi.spyOn(obs.httpRequestsTotal, "inc").mockImplementationOnce(fail);
    if (phase === "histogram")
      vi.spyOn(obs.httpRequestDurationMs, "observe").mockImplementationOnce(
        fail
      );
    if (phase === "completion")
      vi.spyOn(obs, "logRequestEnd").mockImplementationOnce(fail);
    if (phase === "span-finalizer")
      vi.spyOn(otel, "withRootSpan").mockImplementationOnce(
        async (_name, _attrs, callback) => {
          await callback({
            traceId: "trace",
            span: { setAttribute: () => {} },
          } as never);
          throw new Error(sentinel);
        }
      );
    const response = await GET(
      request(
        phase === "construction" || phase === "summary"
          ? "/readyz?deep=1"
          : "/readyz"
      )
    );
    expect(response.status).toBe(
      phase === "local" || phase === "construction" || phase === "error"
        ? 503
        : phase === "logger" ||
            phase === "context" ||
            phase === "span" ||
            phase === "annotation" ||
            phase === "response"
          ? 500
          : 200
    );
    expect(JSON.stringify(await response.json())).not.toContain(sentinel);
    expect(
      JSON.stringify([
        ...mocks.info.mock.calls,
        ...mocks.error.mock.calls,
        ...mocks.warn.mock.calls,
      ])
    ).not.toContain(sentinel);
  });

  it("preserves a resolved 503 when span cleanup fails", async () => {
    const otel = await import("@/bootstrap/otel");
    mocks.serverEnv.mockImplementationOnce(() => {
      throw new Error("PRIVATE_PREFLIGHT");
    });
    vi.spyOn(otel, "withRootSpan").mockImplementationOnce(
      async (_name, _attrs, callback) => {
        await callback({
          traceId: "trace",
          span: { setAttribute: () => {} },
        } as never);
        throw new Error("PRIVATE_SPAN_FINALIZER");
      }
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INTERNAL_ERROR",
    });
    expect(
      JSON.stringify([...mocks.info.mock.calls, ...mocks.error.mock.calls])
    ).not.toContain("PRIVATE_SPAN_FINALIZER");
  });

  it("bounds logs when failed deep response construction throws", async () => {
    const sentinel = "RESPONSE_PRIVATE_SENTINEL";
    mocks.checkEvmRpcConnectivity.mockResolvedValueOnce({
      ok: false,
      source: "live",
      errorMessage: sentinel,
    });
    vi.spyOn(NextResponse, "json").mockImplementationOnce(() => {
      throw new Error(sentinel);
    });
    const response = await GET(request("/readyz?deep=1"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "error",
      reason: "INTERNAL_ERROR",
    });
    const lines = [
      ...mocks.info.mock.calls,
      ...mocks.error.mock.calls,
      ...mocks.warn.mock.calls,
    ];
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(lines)).not.toContain(sentinel);
    expect(
      lines.filter(([fields]) => fields?.event === "substrate.deep.complete")
    ).toHaveLength(1);
    expect(
      lines.filter(([fields]) => fields?.errorCode === "INTERNAL_SERVER_ERROR")
    ).toHaveLength(1);
    expect(
      lines.filter(([, message]) => message === "request complete")
    ).toHaveLength(1);
  });
  it.each([
    "healthy",
    "failed-deep",
  ] as const)("ignores build-info failure for %s", async (scenario) => {
    mocks.setBuildInfo.mockImplementationOnce(() => {
      throw new Error("PRIVATE_BUILD_INFO");
    });
    if (scenario === "failed-deep")
      mocks.checkEvmRpcConnectivity.mockResolvedValueOnce({
        ok: false,
        source: "live",
        errorMessage: "rpc failed",
      });
    const response = await GET(
      request(scenario === "failed-deep" ? "/readyz?deep=1" : "/readyz")
    );
    expect(response.status).toBe(scenario === "healthy" ? 200 : 503);
    expect(
      JSON.stringify([...mocks.info.mock.calls, ...mocks.error.mock.calls])
    ).not.toContain("PRIVATE_BUILD_INFO");
  });
});
