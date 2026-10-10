// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { OpenBaoSecretsAdapter } from "./openbao-secrets.adapter";

const ADDR = "http://openbao.openbao.svc:8200";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAdapter(
  fetchImpl: typeof fetch,
  overrides: Partial<
    ConstructorParameters<typeof OpenBaoSecretsAdapter>[0]
  > = {}
): OpenBaoSecretsAdapter {
  return new OpenBaoSecretsAdapter({
    addr: ADDR,
    role: "candidate-a-node-secrets-writer",
    readServiceAccountToken: async () => "projected-sa-jwt",
    fetchImpl,
    ...overrides,
  });
}

describe("OpenBaoSecretsAdapter", () => {
  it("self-logins then PUTs a brand-new node path (metadata 404)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      if (u.includes("/cogni/metadata/")) return jsonResponse({}, 404);
      // data write — KV v2 requires the `data/` infix in the URL.
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/poly`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ data: { version: 1 } });
    });

    const result = await makeAdapter(fetchImpl).writeSecret({
      nodeSlug: "poly",
      env: "candidate-a",
      key: "POLYGON_RPC_URL",
      value: "https://rpc.example",
      op: "set",
    });

    expect(result).toEqual({
      written: true,
      version: 1,
      path: "cogni/candidate-a/poly/POLYGON_RPC_URL",
    });
    // Login carried the projected SA token, not a caller credential.
    const loginCall = fetchImpl.mock.calls.find(([u]) =>
      String(u).endsWith("/auth/kubernetes/login")
    );
    expect(JSON.parse(String(loginCall?.[1]?.body))).toMatchObject({
      role: "candidate-a-node-secrets-writer",
      jwt: "projected-sa-jwt",
    });
  });

  it("PATCHes an existing node path (metadata 200), preserving siblings", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      if (u.includes("/cogni/metadata/")) return jsonResponse({}, 200);
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/poly`);
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toMatchObject({
        "content-type": "application/merge-patch+json",
      });
      return jsonResponse({ data: { version: 7 } });
    });

    const result = await makeAdapter(fetchImpl).writeSecret({
      nodeSlug: "poly",
      env: "candidate-a",
      key: "POLYGON_RPC_URL",
      value: "https://rpc.example",
      op: "rotate",
    });
    expect(result.version).toBe(7);
  });

  it("never puts the secret value in the URL (only the JSON body)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      expect(u).not.toContain("super-secret-value");
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      if (u.includes("/cogni/metadata/")) return jsonResponse({}, 404);
      return jsonResponse({ data: { version: 1 } });
    });
    await makeAdapter(fetchImpl).writeSecret({
      nodeSlug: "poly",
      env: "candidate-a",
      key: "POLYGON_RPC_URL",
      value: "super-secret-value",
      op: "set",
    });
  });

  it("throws a coded error when self-login fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, 403));
    await expect(
      makeAdapter(fetchImpl).writeSecret({
        nodeSlug: "poly",
        env: "candidate-a",
        key: "POLYGON_RPC_URL",
        value: "x",
        op: "set",
      })
    ).rejects.toMatchObject({ code: "openbao_login_failed", status: 403 });
  });

  it("targets the platform-service bucket when `service` is set, not the node's", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      if (u.includes("/cogni/metadata/")) {
        // The put-vs-patch probe must follow the SERVICE bucket too; probing the
        // node's path would patch a brand-new bucket (or clobber an existing one).
        expect(u).toBe(
          `${ADDR}/v1/cogni/metadata/candidate-a/akash-tx-actuator`
        );
        return jsonResponse({}, 200);
      }
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/akash-tx-actuator`);
      return jsonResponse({ data: { version: 2 } });
    });

    const result = await makeAdapter(fetchImpl).writeSecret({
      nodeSlug: "operator",
      service: "akash-tx-actuator",
      env: "candidate-a",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: "vendor-minted",
      op: "set",
    });

    expect(result).toEqual({
      written: true,
      version: 2,
      path: "cogni/candidate-a/akash-tx-actuator/AKASH_ACTUATOR_CONSOLE_API_KEY",
    });
  });

  it("verifies the current node credential without returning its value", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      expect(u).not.toContain("presented-secret");
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/poly`);
      return jsonResponse({
        data: {
          data: { AUTHORIZATION_FACADE_TOKEN: "presented-secret" },
          metadata: { version: 7, created_time: "2026-10-09T12:00:00Z" },
        },
      });
    });

    await expect(
      makeAdapter(fetchImpl).verifySecret({
        nodeSlug: "poly",
        env: "candidate-a",
        key: "AUTHORIZATION_FACADE_TOKEN",
        presentedValue: "presented-secret",
      })
    ).resolves.toBe(true);
  });

  it("accepts exactly the previous KV version during the bounded rotation overlap", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      if (u.endsWith("?version=6")) {
        return jsonResponse({
          data: {
            data: { AUTHORIZATION_FACADE_TOKEN: "old-token" },
            metadata: { version: 6 },
          },
        });
      }
      return jsonResponse({
        data: {
          data: { AUTHORIZATION_FACADE_TOKEN: "new-token" },
          metadata: { version: 7, created_time: "2026-10-09T12:00:00Z" },
        },
      });
    });
    const adapter = makeAdapter(fetchImpl, {
      now: () => new Date("2026-10-09T12:05:00Z"),
      credentialOverlapMs: 10 * 60_000,
    });

    await expect(
      adapter.verifySecret({
        nodeSlug: "poly",
        env: "candidate-a",
        key: "AUTHORIZATION_FACADE_TOKEN",
        presentedValue: "old-token",
      })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ADDR}/v1/cogni/data/candidate-a/poly?version=6`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("rejects the previous credential after the overlap without reading old versions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login")) {
        return jsonResponse({ auth: { client_token: "s.client" } });
      }
      expect(u).not.toContain("?version=");
      return jsonResponse({
        data: {
          data: { AUTHORIZATION_FACADE_TOKEN: "new-token" },
          metadata: { version: 7, created_time: "2026-10-09T12:00:00Z" },
        },
      });
    });

    await expect(
      makeAdapter(fetchImpl, {
        now: () => new Date("2026-10-09T12:11:00Z"),
        credentialOverlapMs: 10 * 60_000,
      }).verifySecret({
        nodeSlug: "poly",
        env: "candidate-a",
        key: "AUTHORIZATION_FACADE_TOKEN",
        presentedValue: "old-token",
      })
    ).resolves.toBe(false);
  });
});
