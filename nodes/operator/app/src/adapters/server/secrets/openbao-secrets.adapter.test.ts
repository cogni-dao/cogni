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

function makeAdapter(fetchImpl: typeof fetch): OpenBaoSecretsAdapter {
  return new OpenBaoSecretsAdapter({
    addr: ADDR,
    role: "candidate-a-node-secrets-writer",
    readServiceAccountToken: async () => "projected-sa-jwt",
    fetchImpl,
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
});
