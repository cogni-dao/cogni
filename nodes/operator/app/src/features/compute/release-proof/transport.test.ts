// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Test-only injected native capability. No paid resources or runtime evidence. */

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { COMPUTE_PROOF_PATH } from "@/contracts/compute.release-proof.v1.contract";
import {
  type AkashTxHttpDeps,
  createAkashTxActuatorServer,
  createAkashTxDispatcher,
} from "@/features/compute/akash-tx/akash-tx-http";
import type { ComputeReleaseProofInput } from "@/types/compute-release-proof";
import { PublicComputeProof } from "./public-proof";
import { computeProofHash, parseComputeProof } from "./request";

vi.mock("@/ports", () => import("@/ports/akash-tx.port"));

const raw = () => ({
  version: 1,
  nonce: "a".repeat(64),
  expected: {
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    repository: "cogni-dao/cogni",
    environment: "candidate-a",
    sourceSha: "b".repeat(40),
    deploySha: "c".repeat(40),
    bundleRef: `ghcr.io/cogni/bundle@sha256:${"d".repeat(64)}`,
    workloads: [
      {
        instance: null,
        kind: "XComputeWorkload",
        publicHost: "test.cognidao.org",
        leaseGeneration: 0,
        artifacts: [
          { name: "app", image: `ghcr.io/cogni/app@sha256:${"e".repeat(64)}` },
        ],
        services: [
          {
            name: "app",
            artifact: "app",
            runtimeProfile: "image-default",
            commandTemplate: "image-default",
            secretRefs: [],
            bindings: [],
            port: 3000,
            visibility: "public",
            bindHost: "0.0.0.0",
            cpuUnits: 100,
            memoryMi: 256,
            storageMi: 1,
          },
        ],
      },
    ],
  },
});
const output = (input: ComputeReleaseProofInput) => {
  const { workloads: _, ...tuple } = input.expected;
  return {
    version: 1 as const,
    hash: computeProofHash(input as ReturnType<typeof parseComputeProof>),
    nonce: input.nonce,
    tuple,
    observedAt: new Date().toISOString(),
    dimensions: [
      {
        workload: input.expected.nodeId,
        native: "verified" as const,
        migration: "verified" as const,
        provider: "verified" as const,
        code: "verified" as const,
      },
    ],
  };
};
const token = "f".repeat(64),
  wallet = "b".repeat(64);
function harness() {
  const mutation = vi.fn(async () => ({}));
  const sample = vi.fn(async (input: ComputeReleaseProofInput) =>
    output(input)
  );
  const deps = {
    token: wallet,
    proofReadToken: token,
    releaseProof: { sample },
    actuator: new Proxy({}, { get: () => mutation }),
    databaseCellDiagnostic: mutation,
    databaseCellDiagnosticObserve: mutation,
    databaseCellBindings: new Proxy({}, { get: () => mutation }),
    databaseCellAppliedRegistration: new Proxy({}, { get: () => mutation }),
    databaseCellAppliedProbeQualification: new Proxy(
      {},
      { get: () => mutation }
    ),
  } as unknown as AkashTxHttpDeps;
  return { deps, mutation, sample, dispatch: createAkashTxDispatcher(deps) };
}
const routes = [
  "observe-database-cell-diagnostic",
  "prepare-database-cell-diagnostic",
  "create-database-cell",
  "update-database-cell",
  "database-cell-binding/qualify-applied-probe",
  "database-cell-binding/register-applied",
  "database-cell-binding/discover",
  "database-cell-binding/read",
  "database-cell-binding/seal",
  "database-cell-binding/cutover",
  "observe",
  "create",
  "update",
  "delete",
  "lease-log-sources",
].map((x) => `/v1/akash/${x}`);
describe("purpose-only proof transport", () => {
  it("enumerates every actual wallet/diagnostic/custody/log-source route and denies proof authority BEFORE parsing", async () => {
    const source = readFileSync(
      new URL("../akash-tx/akash-tx-http.ts", import.meta.url),
      "utf8"
    );
    expect(
      [...source.matchAll(/case "([^"]+)"/g)].map((m) => m[1]).sort()
    ).toEqual([...routes].sort());
    const h = harness();
    for (const path of [...routes, "/v1/unknown"]) {
      expect(
        (
          await h.dispatch({
            method: "POST",
            path,
            authorization: `Bearer ${token}`,
            body: "NOT JSON",
          })
        ).status
      ).toBe(401);
    }
    expect(h.mutation).not.toHaveBeenCalled();
    expect(h.sample).not.toHaveBeenCalled();
  });
  it("separates wallet/proof tokens, validates before native IO and leaves health independent", async () => {
    const h = harness();
    for (const authorization of [
      undefined,
      `Bearer ${wallet}`,
      "Bearer wrong",
    ]) {
      expect(
        (
          await h.dispatch({
            method: "POST",
            path: COMPUTE_PROOF_PATH,
            ...(authorization ? { authorization } : {}),
            body: "NOT JSON",
          })
        ).status
      ).toBe(401);
    }
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: COMPUTE_PROOF_PATH,
          authorization: `Bearer ${token}`,
          body: JSON.stringify({ ...raw(), namespace: "secret" }),
        })
      ).status
    ).toBe(400);
    expect(h.sample).not.toHaveBeenCalled();
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: "/v1/akash/delete",
          authorization: `Bearer ${wallet}`,
          body: JSON.stringify({ cogniKey: "test/key", externalName: "12345" }),
        })
      ).status
    ).toBe(200);
    expect(h.mutation).toHaveBeenCalledOnce();
    const value = await h.dispatch({
      method: "POST",
      path: COMPUTE_PROOF_PATH,
      authorization: `Bearer ${token}`,
      body: JSON.stringify(raw()),
    });
    expect(value.status).toBe(200);
    expect(JSON.stringify(value)).not.toContain(token);
    const missing = createAkashTxDispatcher({ ...h.deps, proofReadToken: "" });
    expect(
      (
        await missing({
          method: "POST",
          path: COMPUTE_PROOF_PATH,
          body: "NOT JSON",
        })
      ).status
    ).toBe(503);
    expect((await missing({ method: "GET", path: "/healthz" })).status).toBe(
      200
    );
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: "/v1/unknown",
          authorization: `Bearer ${wallet}`,
          body: "{}",
        })
      ).status
    ).toBe(404);
  });
  it("keeps local proof admission fenced until ORIGINAL ignored-abort IO settles; wallet path still responds", async () => {
    const h = harness();
    let finish: () => void = () => {};
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    h.sample.mockImplementation(async (i) => {
      await pending;
      return output(i);
    });
    const abort = new AbortController();
    const first = h.dispatch({
      method: "POST",
      path: COMPUTE_PROOF_PATH,
      authorization: `Bearer ${token}`,
      body: JSON.stringify(raw()),
      signal: abort.signal,
    });
    await Promise.resolve();
    abort.abort();
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: COMPUTE_PROOF_PATH,
          authorization: `Bearer ${token}`,
          body: JSON.stringify(raw()),
        })
      ).status
    ).toBe(429);
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: "/v1/unknown",
          authorization: `Bearer ${wallet}`,
          body: "{}",
        })
      ).status
    ).toBe(404);
    finish();
    expect((await first).status).toBe(503);
    expect(
      (
        await h.dispatch({
          method: "POST",
          path: COMPUTE_PROOF_PATH,
          authorization: `Bearer ${token}`,
          body: JSON.stringify(raw()),
        })
      ).status
    ).toBe(200);
  });
  it("rejects socket query/encoded/suffix aliases and GET without invoking the capability", async () => {
    const h = harness();
    const server = createAkashTxActuatorServer(h.deps);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const send = (path: string, method = "POST") =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: { authorization: `Bearer ${token}` },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify(raw()));
      });
    try {
      for (const path of [
        `${COMPUTE_PROOF_PATH}?x=1`,
        `${COMPUTE_PROOF_PATH}/`,
        COMPUTE_PROOF_PATH.replace("release-proof", "%72elease-proof"),
      ])
        expect(await send(path)).toBe(400);
      expect(await send(COMPUTE_PROOF_PATH, "GET")).toBe(400);
      expect(h.sample).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("cannot return a positive if abort arrives during original admission cleanup", async () => {
    const controller = new AbortController();
    let finish: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered: () => void = () => {};
    const cleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = vi.fn(async () => {
      entered();
      await hold;
    });
    const service = new PublicComputeProof(
      { acquire: async () => ({ signal: controller.signal, release }) },
      { sample: async (input) => output(input) }
    );
    const sample = service.sample(JSON.stringify(raw()), controller.signal);
    await cleaning;
    controller.abort();
    expect(
      (
        await service.sample(
          JSON.stringify(raw()),
          new AbortController().signal
        )
      ).status
    ).toBe(429);
    finish();
    expect((await sample).status).toBe(503);
    expect(release).toHaveBeenCalledOnce();
  });
  it("checks body and local cap before registry, retaining app lease until original client IO settles", async () => {
    const signal = new AbortController();
    let finish: () => void = () => {};
    const hold = new Promise<void>((r) => {
      finish = r;
    });
    const release = vi.fn(async () => {}),
      acquire = vi.fn(async () => ({ signal: signal.signal, release })),
      sample = vi.fn(async (i: ComputeReleaseProofInput) => {
        await hold;
        return output(i);
      });
    const service = new PublicComputeProof({ acquire }, { sample });
    await expect(
      service.sample(
        JSON.stringify({ ...raw(), url: "https://private" }),
        signal.signal
      )
    ).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    const first = service.sample(JSON.stringify(raw()), signal.signal);
    await Promise.resolve();
    signal.abort();
    expect(
      (
        await service.sample(
          JSON.stringify(raw()),
          new AbortController().signal
        )
      ).status
    ).toBe(429);
    expect(release).not.toHaveBeenCalled();
    finish();
    expect((await first).status).toBe(503);
    expect(release).toHaveBeenCalledOnce();
  });
});

import { ComputeReleaseProofClient } from "@/adapters/server/compute/compute-release-proof.client";

describe("fixed private client boundary", () => {
  it("constructs its own fixed destination and bearer; forged transport inputs fail before IO", async () => {
    const send = vi.fn(() => {
      throw new Error("test-only transport stop");
    }) as unknown as typeof httpRequest;
    const client = new ComputeReleaseProofClient(
      "cogni-candidate-a",
      token,
      send
    );
    const signal = new AbortController().signal;
    await expect(
      client.sample(parseComputeProof(JSON.stringify(raw())), signal)
    ).rejects.toThrow("test-only transport stop");
    const call = required(vi.mocked(send).mock.calls[0]);
    expect(String(call[0])).toBe(
      "http://akash-tx-actuator.cogni-candidate-a.svc.cluster.local:8080/v1/compute/release-proof"
    );
    expect(call[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    vi.mocked(send).mockClear();
    for (const field of [
      "url",
      "path",
      "headers",
      "authorization",
      "cookie",
      "forwardedHost",
    ]) {
      const input = { ...raw(), [field]: "hostile" };
      await expect(
        client.sample(input as unknown as ComputeReleaseProofInput, signal)
      ).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
    await expect(
      new ComputeReleaseProofClient("cogni-candidate-a", "", send).sample(
        parseComputeProof(JSON.stringify(raw())),
        signal
      )
    ).rejects.toThrow("unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(
      () => new ComputeReleaseProofClient("evil.invalid", token, send)
    ).toThrow();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("unavailable");
  return value;
}

import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { SUBSTRATE_RESERVED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";
import { loadSecretsCatalog } from "../../../../../../../scripts/lib/secrets-catalog-loader";

describe("proof credential custody declarations", () => {
  it("loads through the real catalog schema, reserves the key and projects only the selected operator properties", () => {
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const loaded = loadSecretsCatalog({ repoRoot });
    expect(loaded.routing.COMPUTE_PROOF_READ_TOKEN?.service).toBe("operator");
    expect(
      loaded.secrets.find((s) => s.name === "COMPUTE_PROOF_READ_TOKEN")
    ).toMatchObject({ source: "agent", required: false });
    expect(SUBSTRATE_RESERVED_KEYS.has("COMPUTE_PROOF_READ_TOKEN")).toBe(true);
    const catalog = parseYaml(
      readFileSync(`${repoRoot}/infra/secrets-catalog.yaml`, "utf8")
    );
    const entry = catalog.secrets.find(
      (s: { name: string }) => s.name === "COMPUTE_PROOF_READ_TOKEN"
    );
    expect(entry).toMatchObject({
      tier: "A1",
      service: "operator",
      generate: { kind: "hex", bytes: 32 },
    });
    expect(entry.inheritFrom).toBeUndefined();
    expect(entry.syncTo).toBeUndefined();
    expect(entry.shared).toBeUndefined();
    const baseline = readFileSync(
      `${repoRoot}/scripts/setup/lib/reconcile-secrets.sh`,
      "utf8"
    );
    expect(
      baseline.match(/NODE_BASELINE_KEYS=\(([\s\S]*?)\n\)/)?.[1]
    ).toContain("COMPUTE_PROOF_READ_TOKEN");
    const deployment = parseYaml(
      readFileSync(
        `${repoRoot}/infra/k8s/base/akash-tx-actuator/deployment.yaml`,
        "utf8"
      )
    );
    const sources = deployment.spec.template.spec.volumes[0].projected.sources;
    expect(
      sources.find(
        (s: { secret: { name: string } }) =>
          s.secret.name === "operator-env-secrets"
      ).secret.items
    ).toEqual([
      { key: "DATABASE_URL", path: "DATABASE_URL" },
      { key: "COMPUTE_PROOF_READ_TOKEN", path: "COMPUTE_PROOF_READ_TOKEN" },
    ]);
  });
});
