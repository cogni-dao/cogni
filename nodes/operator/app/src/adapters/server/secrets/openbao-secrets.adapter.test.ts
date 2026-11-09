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
});

describe("OpenBaoSecretsAdapter.ensureGeneratedKeys (bug.5254: create-if-absent)", () => {
  const DATA = `${ADDR}/v1/cogni/data/candidate-a/red`;
  const RECIPES = {
    SANDBOX_EXECD_TOKEN: { kind: "hex" as const, bytes: 32 },
  };
  type Step = (init: RequestInit | undefined) => Response;
  /** Login, then a scripted sequence of data-path responses. */
  function scripted(steps: Step[]) {
    const writes: { method?: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/auth/kubernetes/login"))
        return jsonResponse({ auth: { client_token: "s.client" } });
      expect(u).toBe(DATA);
      if (init?.method && init.method !== "GET")
        writes.push({
          method: init.method,
          body: JSON.parse(String(init.body)),
        });
      const step = steps.shift();
      if (!step) throw new Error("unexpected call");
      return step(init);
    });
    return { fetchImpl, writes };
  }
  const read =
    (version: number, data: Record<string, string>): Step =>
    () =>
      jsonResponse({ data: { data, metadata: { version } } });

  it("creates an absent bucket with cas 0 and returns names, never values", async () => {
    const { fetchImpl, writes } = scripted([
      () => jsonResponse({}, 404),
      () => jsonResponse({ data: { version: 1 } }),
    ]);
    const result = await makeAdapter(fetchImpl).ensureGeneratedKeys({
      nodeSlug: "red",
      env: "candidate-a",
      recipes: RECIPES,
    });
    expect(result).toEqual({ generated: ["SANDBOX_EXECD_TOKEN"], version: 1 });
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.body.options).toEqual({ cas: 0 });
    const token = (writes[0]?.body.data as Record<string, string>)
      .SANDBOX_EXECD_TOKEN;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("never touches a key that already exists (no write at all)", async () => {
    const { fetchImpl, writes } = scripted([
      read(3, { SANDBOX_EXECD_TOKEN: "existing", OTHER: "x" }),
    ]);
    const result = await makeAdapter(fetchImpl).ensureGeneratedKeys({
      nodeSlug: "red",
      env: "candidate-a",
      recipes: RECIPES,
    });
    expect(result).toEqual({ generated: [], version: 3 });
    expect(writes).toEqual([]);
  });

  it("patches only the missing key with cas = the read version", async () => {
    const { fetchImpl, writes } = scripted([
      read(3, { OTHER: "x" }),
      () => jsonResponse({ data: { version: 4 } }),
    ]);
    const result = await makeAdapter(fetchImpl).ensureGeneratedKeys({
      nodeSlug: "red",
      env: "candidate-a",
      recipes: RECIPES,
    });
    expect(result).toEqual({ generated: ["SANDBOX_EXECD_TOKEN"], version: 4 });
    expect(writes[0]?.method).toBe("PATCH");
    expect(writes[0]?.body.options).toEqual({ cas: 3 });
    expect(Object.keys(writes[0]?.body.data as object)).toEqual([
      "SANDBOX_EXECD_TOKEN",
    ]);
  });

  it("on a check-and-set conflict re-reads and converges on the winner's value", async () => {
    const { fetchImpl, writes } = scripted([
      read(3, { OTHER: "x" }),
      () =>
        new Response(
          JSON.stringify({
            errors: [
              "check-and-set parameter did not match the current version",
            ],
          }),
          { status: 400 }
        ),
      read(4, { OTHER: "x", SANDBOX_EXECD_TOKEN: "winner" }),
    ]);
    const result = await makeAdapter(fetchImpl).ensureGeneratedKeys({
      nodeSlug: "red",
      env: "candidate-a",
      recipes: RECIPES,
    });
    expect(result).toEqual({ generated: [], version: 4 });
    expect(writes).toHaveLength(1);
  });

  it("a non-CAS 400 fails at once instead of retrying", async () => {
    const { fetchImpl } = scripted([
      read(3, {}),
      () =>
        new Response(JSON.stringify({ errors: ["bad payload"] }), {
          status: 400,
        }),
    ]);
    await expect(
      makeAdapter(fetchImpl).ensureGeneratedKeys({
        nodeSlug: "red",
        env: "candidate-a",
        recipes: RECIPES,
      })
    ).rejects.toMatchObject({ code: "openbao_cas_write_failed" });
  });

  it("refuses the operator bucket before any call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      makeAdapter(fetchImpl).ensureGeneratedKeys({
        nodeSlug: "operator",
        env: "candidate-a",
        recipes: RECIPES,
      })
    ).rejects.toThrow("openbao_generate_bucket_refused");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
