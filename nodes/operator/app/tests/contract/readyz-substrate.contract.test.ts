// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-substrate.contract`
 * Purpose: Prove the local-only shallow readiness and explicit deep substrate contract.
 * Scope: Exercises the /readyz route with isolated RPC, Temporal, scheduler-worker, knowledge-store, and database probes. Does not perform real network or database IO.
 * Invariants: Default readiness performs zero remote IO; `?deep=1` returns 503 for any missing dependency, knowledge plane included (bug.5386).
 * Side-effects: none
 * Links: src/app/(infra)/readyz/route.ts, Cogni-DAO/cogni#1860
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEvmRpcConfig: vi.fn(),
  assertKnowledgeStoreConnectivity: vi.fn(),
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
      knowledgeStorePort: { domainExists: async () => false },
      paymentRailsActive: false,
      scheduleControl: {},
      serviceAccountService: {},
    },
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) => mocks.verifySystemTenant(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: {
          log: {
            debug: ReturnType<typeof vi.fn>;
            error: ReturnType<typeof vi.fn>;
            info: ReturnType<typeof vi.fn>;
            warn: ReturnType<typeof vi.fn>;
          };
        },
        request: NextRequest
      ) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler(
        {
          log: {
            debug: vi.fn(),
            error: mocks.error,
            info: mocks.info,
            warn: mocks.warn,
          },
        },
        request
      ),
}));

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
    assertKnowledgeStoreConnectivity: (...args: unknown[]) =>
      mocks.assertKnowledgeStoreConnectivity(...args),
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

vi.mock("@/shared/observability/server/metrics", () => ({
  setBuildInfo: (...args: unknown[]) => mocks.setBuildInfo(...args),
}));

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
    mocks.assertEvmRpcConfig.mockReset();
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
    });
    mocks.assertTemporalConnectivity.mockResolvedValue(undefined);
    mocks.assertSchedulerWorkerConnectivity.mockResolvedValue(undefined);
    mocks.assertKnowledgeStoreConnectivity.mockResolvedValue(undefined);
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
    mocks.assertKnowledgeStoreConnectivity.mockReturnValue(never);
    mocks.verifySystemTenant.mockReturnValue(never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.assertEvmRpcConfig).toHaveBeenCalledOnce();
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertTemporalConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.assertKnowledgeStoreConnectivity).not.toHaveBeenCalled();
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
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.evm_rpc.unreachable",
        severity: "critical",
      }),
      "deep readiness: EVM RPC unreachable"
    );
  });

  it("records successful deep RPC proof", async () => {
    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.evm_rpc.reachable",
        dependency: "evm-rpc",
      }),
      "deep readiness: EVM RPC reachable"
    );
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

  it("returns 503 from the deep probe when Temporal is unavailable", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "Temporal is unavailable",
    });
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("returns 503 from the deep probe when scheduler-worker is unavailable", async () => {
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker is unavailable",
    });
    expect(mocks.assertTemporalConnectivity).toHaveBeenCalledOnce();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });
  it("does not consult a wedged knowledge plane from shallow readiness (bug.5386)", async () => {
    mocks.assertKnowledgeStoreConnectivity.mockRejectedValue(
      new InfraConnectivityError(
        "Knowledge store connectivity check failed: knowledge store did not answer within 3000ms (pool exhausted or wedged)"
      )
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.assertKnowledgeStoreConnectivity).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("returns 503 from the deep probe when the knowledge plane is wedged (bug.5386)", async () => {
    // This is the gate. candidate-flight's verify-candidate certified a node
    // whose entire Doltgres plane was unresponsive; deep readiness must refuse.
    mocks.assertKnowledgeStoreConnectivity.mockRejectedValue(
      new InfraConnectivityError("knowledge store is wedged")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "knowledge store is wedged",
    });
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("probes the container's knowledge store port", async () => {
    await GET(request("/readyz?deep=1"));

    expect(mocks.assertKnowledgeStoreConnectivity).toHaveBeenCalledWith(
      expect.objectContaining({ domainExists: expect.any(Function) })
    );
  });
});
