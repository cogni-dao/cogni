// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  handleFlightProbeCredentialProjection,
  type ProjectionDeps,
} from "./route";

const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const ACTIVE = "a".repeat(32);

function request(
  body: unknown = { lane: "candidate-a", nodeId: NODE_ID },
  token = "github-oidc-jwt",
  url = "https://cognidao.org/api/internal/flight-probe-credentials"
) {
  const encoded = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  });
}

function deps(overrides: Partial<ProjectionDeps> = {}): ProjectionDeps {
  return {
    isControl: () => true,
    isCatalogNode: (nodeId: string) => nodeId === NODE_ID,
    consumeRateLimit: () => true,
    readRing: vi.fn().mockResolvedValue({ active: ACTIVE, previous: null }),
    audit: vi.fn(),
    ...overrides,
  };
}

describe("flight-probe credential projection route", () => {
  it("returns one bounded ring with no-store", async () => {
    const d = deps();
    const res = await handleFlightProbeCredentialProjection(request(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      active: ACTIVE,
      previous: null,
    });
    expect(d.readRing).toHaveBeenCalledWith({
      oidcJwt: "github-oidc-jwt",
      lane: "candidate-a",
      nodeId: NODE_ID,
    });
  });

  it.each([
    ["non-control", { isControl: () => false }],
    ["unknown node", { isCatalogNode: () => false }],
    [
      "OpenBao rejection",
      { readRing: vi.fn().mockRejectedValue(new Error("denied")) },
    ],
  ])("uses the same denial for %s", async (_case, override) => {
    const res = await handleFlightProbeCredentialProjection(
      request(),
      deps(override)
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("requires TLS before consulting OpenBao", async () => {
    const d = deps();
    const res = await handleFlightProbeCredentialProjection(
      request(
        undefined,
        "github-oidc-jwt",
        "http://cognidao.org/api/internal/flight-probe-credentials"
      ),
      d
    );
    expect(res.status).toBe(401);
    expect(d.readRing).not.toHaveBeenCalled();
  });

  it("rate limits before exchanging the caller JWT", async () => {
    const d = deps({ consumeRateLimit: () => false });
    const res = await handleFlightProbeCredentialProjection(request(), d);
    expect(res.status).toBe(429);
    expect(d.readRing).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even without content-length", async () => {
    const req = new Request(
      "https://cognidao.org/api/internal/flight-probe-credentials",
      {
        method: "POST",
        headers: {
          authorization: "Bearer github-oidc-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          lane: "candidate-a",
          nodeId: NODE_ID,
          padding: "x".repeat(512),
        }),
      }
    );
    const d = deps();
    const res = await handleFlightProbeCredentialProjection(req, d);
    expect(res.status).toBe(401);
    expect(d.readRing).not.toHaveBeenCalled();
  });
});
