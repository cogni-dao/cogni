// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Test-only injected native capability. No paid resources or runtime evidence. */

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  type AddressInfo,
  connect as netConnect,
  createServer as netServer,
  type Socket,
} from "node:net";
import { describe, expect, it, vi } from "vitest";
import { COMPUTE_PROOF_PATH } from "@/contracts/compute.release-proof.v1.contract";
import {
  type AkashTxHttpDeps,
  createAkashTxActuatorServer,
  createAkashTxDispatcher,
} from "@/features/compute/akash-tx/akash-tx-http";
import { NativeComputeReleaseProofAdapter } from "@/features/compute/release-proof/native-proof";
import { PublicComputeProof } from "@/features/compute/release-proof/public-proof";
import {
  computeProofHash,
  parseComputeProof,
} from "@/features/compute/release-proof/request";
import type { ComputeReleaseProofInput } from "@/types/compute-release-proof";

// Test-only barrel isolation retains the ACTUAL port error classes without loading
// unrelated optional authorization SDKs. This test lives outside feature layering.
vi.mock("@/ports", () => import("@/ports/akash-tx.port"));
// Keep the actual logger; isolate unrelated metrics/authorization barrel dependencies.
vi.mock(
  "@/shared/observability",
  () => import("@/shared/observability/server/logger")
);

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
      new URL(
        "../../../../src/features/compute/akash-tx/akash-tx-http.ts",
        import.meta.url
      ),
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
import { AkashComputeAdapter } from "@/adapters/server/compute/akash-compute.adapter";
import { optionalComputeProofIdentity } from "@/bootstrap/compute-proof-identity";
import { SUBSTRATE_RESERVED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";
import { loadSecretsCatalog } from "../../../../../../../scripts/lib/secrets-catalog-loader";

describe("private proof standalone composition and bounded errors", () => {
  it("loads shipped public identity without web env and keeps wallet/health routes with missing optional identity", async () => {
    for (const key of [
      "AUTH_SECRET",
      "DATABASE_SERVICE_URL",
      "LITELLM_MASTER_KEY",
      "COGNI_REPO_PATH",
      "DATABASE_URL",
      "APP_ENV",
    ])
      vi.stubEnv(key, undefined);
    try {
      const root = fileURLToPath(
        new URL("../../../../../../../", import.meta.url)
      );
      const identity = optionalComputeProofIdentity(() =>
        readFileSync(`${root}/nodes/operator/.cogni/repo-spec.yaml`, "utf8")
      );
      expect(identity).toEqual({
        nodeId: raw().expected.nodeId,
        repository: "cogni-dao/cogni",
      });
      const source = readFileSync(
        `${root}/nodes/operator/app/src/bootstrap/akash-tx-actuator.ts`,
        "utf8"
      );
      expect(source).not.toContain("repoSpec.server");
      expect(source).not.toContain("serverEnv(");
      for (const readSpec of [
        () =>
          readFileSync(`${root}/nodes/operator/.cogni/repo-spec.yaml`, "utf8"),
        () => {
          throw new Error("absent");
        },
        () => "node_id: malformed",
      ]) {
        const optionalIdentity = optionalComputeProofIdentity(readSpec);
        const h = harness();
        const { releaseProof: _proof, ...walletDeps } = h.deps;
        const deps: AkashTxHttpDeps = {
          ...walletDeps,
          ...(optionalIdentity
            ? {
                releaseProof: new NativeComputeReleaseProofAdapter(
                  {
                    json: async () => {
                      throw new Error("native unavailable");
                    },
                    log: async () => {
                      throw new Error("native unavailable");
                    },
                  },
                  undefined,
                  {},
                  { ...optionalIdentity, namespace: "cogni-candidate-a" }
                ),
              }
            : {}),
        };
        const dispatcher = createAkashTxDispatcher(deps);
        const server = createAkashTxActuatorServer(deps);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(
              {
                host: "127.0.0.1",
                port: (server.address() as AddressInfo).port,
                path: "/healthz",
                method: "GET",
              },
              (res) => {
                res.resume();
                res.once("end", () => resolve(res.statusCode ?? 0));
              }
            );
            req.once("error", reject);
            req.end();
          });
          expect(status).toBe(200);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        const result = await dispatcher({
          method: "POST",
          path: "/v1/akash/observe",
          authorization: `Bearer ${wallet}`,
          body: "{}",
        });
        expect(result.status).not.toBe(401);
        expect(
          (
            await dispatcher({
              method: "POST",
              path: COMPUTE_PROOF_PATH,
              authorization: `Bearer ${token}`,
              body: JSON.stringify(raw()),
            })
          ).status
        ).toBe(optionalIdentity ? 200 : 503);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("never collects oversized non2xx bodies and awaits the original body cancellation", async () => {
    let settle: (() => void) | undefined;
    const cancelled = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel: cancelled,
      }),
      { status: 500 }
    );
    const text = vi.spyOn(response, "text");
    const adapter = new AkashComputeAdapter({
      apiKey: "test-only",
      timeoutMs: 1000,
      outcomeStore: {
        record: async () => {
          throw new Error("unexpected mutation");
        },
        stats: async () => new Map(),
      },
      fetchImpl: vi.fn(async () => response),
    });
    let finished = false;
    const original = adapter
      .readManagedDefinition({
        leaseId: "12345",
        signal: new AbortController().signal,
      })
      .catch((error) => {
        finished = true;
        throw error;
      });
    void original.catch(() => {});
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(text).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    settle?.();
    await expect(original).rejects.toThrow("HTTP 500");
    expect(finished).toBe(true);
  });
});

describe("operator proof connection budget source envelope", () => {
  it("includes Recreate, one actuator/worker rollout with drain, diagnostics and reconnect margin", () => {
    const root = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const yaml = (path: string) =>
      parseYaml(readFileSync(`${root}/${path}`, "utf8"));
    const app = yaml("infra/k8s/base/node-app/deployment.yaml");
    const actuator = yaml("infra/k8s/base/akash-tx-actuator/deployment.yaml");
    const worker = yaml("infra/k8s/base/scheduler-worker/deployment.yaml");
    for (const lane of ["candidate-a", "preview", "production"]) {
      const overlay = yaml(
        `infra/k8s/overlays/${lane}/operator/kustomization.yaml`
      );
      const patches = overlay.patches.filter(
        (p: { target?: { kind?: string; name?: string }; patch?: string }) =>
          p.target?.kind === "Deployment" &&
          p.target?.name === "node-app" &&
          p.patch
      );
      const strategy = patches
        .flatMap((p: { patch: string }) => parseYaml(p.patch))
        .find((p: { path: string }) => p.path === "/spec/strategy");
      expect(strategy?.value).toEqual({ type: "Recreate" });
    }
    expect(app.spec.replicas).toBe(1);
    expect(actuator.spec.replicas).toBe(1);
    expect(actuator.spec.strategy.rollingUpdate.maxSurge).toBe(1);
    expect(worker.spec.replicas).toBe(2);
    expect(worker.spec.strategy).toBeUndefined(); // Kubernetes default 25% surge => ceil(2/4)=1.
    const acceptingActuators =
      actuator.spec.replicas + actuator.spec.strategy.rollingUpdate.maxSurge;
    const drainingActuators = actuator.spec.replicas;
    const acceptingWorkers =
      worker.spec.replicas + Math.ceil(worker.spec.replicas * 0.25);
    const drainingWorkers = worker.spec.replicas;
    const appDemand =
      app.spec.replicas * 2 +
      (acceptingActuators + drainingActuators) * (1 + 1) +
      1;
    const serviceDemand =
      app.spec.replicas * (4 + 1) +
      (acceptingWorkers + drainingWorkers) * 2 +
      1 +
      1;
    const budget = yaml("infra/database-budget-profiles.yaml")[
      "operator-control-v1"
    ];
    expect(appDemand).toBe(9);
    expect(serviceDemand).toBe(17);
    expect(budget.roles.app.connection_limit).toBeGreaterThanOrEqual(appDemand);
    expect(budget.roles.service.connection_limit).toBeGreaterThanOrEqual(
      serviceDemand
    );
    // Existing materializers continue to consume this profile. This finite source
    // envelope does not prove arbitrary overlapping rollouts or native wallet capacity.
  });
});

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

import type { Database } from "@cogni/db-client";
import * as proofTestSchema from "@cogni/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { PostgresComputeProofAdmission } from "@/adapters/server/compute/compute-release-proof-admission.adapter";
import { PostgresComputeProofAllocationReader } from "@/adapters/server/compute/compute-release-proof-allocation.adapter";

describe("real driver half-open cold connection fence", () => {
  it("permanently retires both proof lanes when end and original reserve settle before TCP closure", async () => {
    for (const kind of ["allocation", "admission"]) {
      const peers: Socket[] = [];
      const server = netServer({ allowHalfOpen: true }, (socket) => {
        peers.push(socket);
        socket.on("error", () => {});
        socket.on("data", () => {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const dsn = `postgres://proof_test@127.0.0.1:${address.port}/postgres`;
      const allocation = new PostgresComputeProofAllocationReader(
        dsn,
        `akash-console:akash1${"x".repeat(38)}`
      );
      const admission = new PostgresComputeProofAdmission(dsn);
      const input = parseComputeProof(JSON.stringify(raw()));
      const attempt = () =>
        kind === "allocation"
          ? allocation.readOwnedAllocations(
              {
                nodeId: input.expected.nodeId,
                environment: input.expected.environment,
              },
              new AbortController().signal
            )
          : admission.acquire(input, new AbortController().signal);
      try {
        const started = performance.now();
        await expect(attempt()).rejects.toThrow("unavailable");
        expect(performance.now() - started).toBeLessThan(1500);
        expect(peers).toHaveLength(1);
        expect(peers[0]?.destroyed).toBe(false);
        await expect(attempt()).rejects.toThrow("unavailable");
        expect(peers).toHaveLength(1); // No replacement connection while original is half-open.
      } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  });
});

// This lane requires an explicit, empty, temporary LOCAL PostgreSQL fixture. It never
// reads .env.test/node DSNs, inserts allocation/payment receipts, or contacts a provider.
const localProofDsn = process.env.COMPUTE_PROOF_TEST_DATABASE_URL ?? "";
const localProofFixture =
  process.env.COMPUTE_PROOF_TEST_LOCAL_EMPTY_FIXTURE === "1" &&
  /^postgres:\/\/proof_test@127\.0\.0\.1:\d+\/postgres$/.test(localProofDsn);
describe.skipIf(!localProofFixture)(
  "real proof allocation transport (empty local PostgreSQL only)",
  () => {
    const options = {
      max: 1,
      connect_timeout: 1,
      connection: { application_name: "proof-test-control" },
    };
    let fixtureCreated = false;
    let blocker: ReturnType<typeof postgres>,
      observer: ReturnType<typeof postgres>,
      wallet: ReturnType<typeof postgres>;
    const input = {
      nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
      environment: "candidate-a",
    };
    const scope = `akash-console:akash1${"x".repeat(38)}`;
    beforeAll(async () => {
      blocker = postgres(localProofDsn, options);
      observer = postgres(localProofDsn, options);
      wallet = postgres(localProofDsn, {
        ...options,
        connection: { application_name: "proof-test-wallet" },
      });
      const tables =
        await observer`SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='akash_tx_allocations'`;
      if (tables.length !== 0) throw new Error("fixture must start empty");
      // EMPTY test relation only. No fabricated paid receipt or provider-success row.
      await observer`CREATE TABLE public.akash_tx_allocations (node_id uuid,composite_uid text,composite_generation integer,workload text,environment text,state text,external_name text,provider_account text,wallet_scope text,updated_at timestamptz,id uuid,cogni_key text,allocation_cursor text,last_applied_sdl_hash text,applied_database_cell_binding jsonb)`;
      fixtureCreated = true;
      // Inert LOCAL registry fixture only; never an allocation/payment/provider receipt.
      await observer`CREATE TABLE public.nodes (id uuid, slug text, repo_owner text, repo_name text, deploy_envs text[])`;
      await observer`INSERT INTO public.nodes VALUES (${input.nodeId}::uuid,'operator','cogni-dao','cogni',ARRAY['candidate-a'])`;
    });
    afterAll(async () => {
      if (fixtureCreated) {
        await observer`DROP TABLE public.akash_tx_allocations`;
        await observer`DROP TABLE public.nodes`;
      }
      await Promise.all([
        blocker?.end({ timeout: 0 }),
        observer?.end({ timeout: 0 }),
        wallet?.end({ timeout: 0 }),
      ]);
    });
    async function lockedReader() {
      const lock = await blocker.reserve();
      await lock`BEGIN`;
      await lock`LOCK TABLE public.akash_tx_allocations IN ACCESS EXCLUSIVE MODE`;
      const reader = new PostgresComputeProofAllocationReader(
          localProofDsn,
          scope
        ),
        controller = new AbortController();
      const original = reader.readOwnedAllocations(input, controller.signal);
      void original.catch(() => {});
      let pid: number | undefined;
      for (let i = 0; i < 30; i++) {
        const rows = await observer<
          { pid: number }[]
        >`SELECT pid FROM pg_stat_activity WHERE application_name='compute-release-proof-allocation' AND wait_event_type='Lock'`;
        if (rows[0]) {
          pid = rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!pid) {
        controller.abort();
        await original.catch(() => {});
        await lock`ROLLBACK`;
        lock.release();
        throw new Error("real read never reached the relation lock");
      }
      return { lock, reader, controller, original, pid };
    }
    it("aborts the original locked SELECT, refuses queueing, settles before reuse and leaves wallet capacity available", async () => {
      const h = await lockedReader();
      try {
        const started = performance.now();
        expect((await wallet`SELECT 1 AS available`)[0]?.available).toBe(1);
        expect(performance.now() - started).toBeLessThan(1000);
        await expect(
          h.reader.readOwnedAllocations(input, new AbortController().signal)
        ).rejects.toThrow("unavailable");
        h.controller.abort();
        await expect(h.original).rejects.toThrow("unavailable");
        expect(performance.now() - started).toBeLessThan(2000);
      } finally {
        h.controller.abort();
        await h.original.catch(() => {});
        await h.lock`ROLLBACK`;
        h.lock.release();
      }
      // A lock-waiting backend may not ACK Terminate before the close deadline.
      // That instance stays retired. If it is reusable, the original backend MUST be gone.
      const reused = await h.reader
        .readOwnedAllocations(input, new AbortController().signal)
        .then(
          () => true,
          () => false
        );
      if (reused)
        expect(
          await observer`SELECT pid FROM pg_stat_activity WHERE pid=${h.pid}`
        ).toHaveLength(0);
      const healthy = new PostgresComputeProofAllocationReader(
        localProofDsn,
        scope
      );
      expect(
        await healthy.readOwnedAllocations(input, new AbortController().signal)
      ).toEqual([]);
      expect(
        await healthy.readOwnedAllocations(input, new AbortController().signal)
      ).toEqual([]);
      expect((await wallet`SELECT 1 AS available`)[0]?.available).toBe(1);
      const walletDb: Database = drizzle(wallet, { schema: proofTestSchema });
      const actualWalletLedger = new DrizzleAkashTxAllocationLedger(
        async () => walletDb,
        scope
      );
      expect(
        await actualWalletLedger.listAllocated({ ...input, limit: 1 })
      ).toEqual([]);
    });
    it("bounds an original lock wait without caller cancellation", async () => {
      const started = performance.now(),
        h = await lockedReader();
      try {
        await expect(h.original).rejects.toThrow("unavailable");
        expect(performance.now() - started).toBeLessThan(2000);
        expect((await wallet`SELECT 1 AS available`)[0]?.available).toBe(1);
      } finally {
        h.controller.abort();
        await h.original.catch(() => {});
        await h.lock`ROLLBACK`;
        h.lock.release();
      }
    });
    it("aborts a silent established health response within one second and refuses replacement without confirmed closure", async () => {
      const healthyAdmission = new PostgresComputeProofAdmission(localProofDsn);
      const parsedInput = parseComputeProof(JSON.stringify(raw()));
      for (let attempt = 0; attempt < 2; attempt++) {
        const healthyLease = await healthyAdmission.acquire(
          parsedInput,
          new AbortController().signal
        );
        await healthyLease.release();
        expect(healthyLease.signal.aborted).toBe(false);
      }
      const sockets: Socket[] = [];
      let blackhole = false;
      const target = new URL(localProofDsn);
      const server = netServer({ allowHalfOpen: true }, (front) => {
        const backend = netConnect({
          host: "127.0.0.1",
          port: Number(target.port),
          allowHalfOpen: true,
        });
        sockets.push(front, backend);
        front.on("error", () => {});
        backend.on("error", () => {});
        front.pipe(backend, { end: false });
        backend.on("data", (chunk) => {
          if (!blackhole) front.write(chunk);
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const admission = new PostgresComputeProofAdmission(
        `postgres://proof_test@127.0.0.1:${address.port}/postgres`
      );
      const parsed = parseComputeProof(JSON.stringify(raw()));
      try {
        const lease = await admission.acquire(
          parsed,
          new AbortController().signal
        );
        blackhole = true;
        const started = performance.now();
        await Promise.race([
          once(lease.signal, "abort"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("health deadline missing")), 1500)
          ),
        ]);
        expect(performance.now() - started).toBeLessThan(1100);
        await expect(lease.release()).rejects.toThrow("unavailable");
        await expect(
          admission.acquire(parsed, new AbortController().signal)
        ).rejects.toThrow("unavailable");
        expect((await wallet`SELECT 1 AS available`)[0]?.available).toBe(1);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
    it("settles real proof backend loss without destroying the wallet session", async () => {
      const walletBefore = (await wallet`SELECT pg_backend_pid() AS pid`)[0]
        ?.pid;
      const h = await lockedReader(),
        started = performance.now();
      try {
        await observer`SELECT pg_terminate_backend(${h.pid})`;
        await expect(h.original).rejects.toThrow("unavailable");
        expect(performance.now() - started).toBeLessThan(2000);
        expect((await wallet`SELECT pg_backend_pid() AS pid`)[0]?.pid).toBe(
          walletBefore
        );
      } finally {
        h.controller.abort();
        await h.original.catch(() => {});
        await h.lock`ROLLBACK`;
        h.lock.release();
      }
    });
  }
);
