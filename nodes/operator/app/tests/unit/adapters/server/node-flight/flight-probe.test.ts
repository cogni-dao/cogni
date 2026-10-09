// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for governed flight-probe adapters.
 * Purpose: Pin exact credential selection and HTTP result classification without network I/O.
 * Scope: Env-backed resolver plus HttpNodeProber run-carries method with mocked fetch.
 * Invariants: no default credential, no cross-env/node reuse, no anonymous registration.
 * Side-effects: mocked global fetch
 * Links: task.5218, task.5223
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvFlightProbeCredentialResolver } from "@/adapters/server/node-flight/flight-probe-credential.adapter";
import { HttpNodeProber } from "@/adapters/server/node-flight/node-prober.adapter";

const target = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  env: "candidate-a" as const,
  host: "poly-test.cognidao.org",
};
const apiKey = "k".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EnvFlightProbeCredentialResolver", () => {
  it("resolves only the exact env/node pair", () => {
    const resolver = new EnvFlightProbeCredentialResolver(
      JSON.stringify({ [`${target.env}/${target.nodeId}`]: apiKey })
    );
    expect(resolver.resolve(target)).toEqual({ apiKey });
    expect(resolver.resolve({ ...target, env: "preview" })).toBeNull();
    expect(
      resolver.resolve({
        ...target,
        nodeId: "22222222-2222-4222-8222-222222222222",
      })
    ).toBeNull();
  });

  it("fails closed for absent, malformed, or short secret maps", () => {
    expect(
      new EnvFlightProbeCredentialResolver(undefined).resolve(target)
    ).toBeNull();
    expect(new EnvFlightProbeCredentialResolver("{").resolve(target)).toBeNull();
    expect(
      new EnvFlightProbeCredentialResolver(
        JSON.stringify({ [`${target.env}/${target.nodeId}`]: "short" })
      ).resolve(target)
    ).toBeNull();
  });
});

describe("HttpNodeProber.runCarries", () => {
  it("fails without performing I/O when the exact credential is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const prober = new HttpNodeProber({ resolve: () => null });

    await expect(prober.runCarries(target)).resolves.toMatchObject({
      status: "fail",
      runs: 0,
      detail: "probe-credential-missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts only to the bounded endpoint and accepts a contract-valid run proof", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        runId: "33333333-3333-4333-8333-333333333333",
        principalId: `service:${target.nodeId}/flight-prober`,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const prober = new HttpNodeProber({ resolve: () => ({ apiKey }) });

    await expect(prober.runCarries(target)).resolves.toMatchObject({
      status: "pass",
      runs: 1,
      detail: "probe-complete",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://${target.host}/api/internal/flight-probe`
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: `Bearer ${apiKey}`,
      }),
    });
  });

  it("degrades only after the endpoint proves a run was created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ok: false,
          runId: "33333333-3333-4333-8333-333333333333",
          principalId: `service:${target.nodeId}/flight-prober`,
        })
      )
    );
    const prober = new HttpNodeProber({ resolve: () => ({ apiKey }) });
    await expect(prober.runCarries(target)).resolves.toMatchObject({
      status: "degraded",
      runs: 1,
      detail: "graph-error",
    });
  });

  it("fails closed on target auth rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({}, { status: 401 }))
    );
    const prober = new HttpNodeProber({ resolve: () => ({ apiKey }) });
    await expect(prober.runCarries(target)).resolves.toMatchObject({
      status: "fail",
      runs: 0,
      detail: "probe-http-401",
    });
  });
});
