// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { computeProofHash, parseComputeProof } from "./request";
export const requestFixture = () => ({
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
            runtimeProfile: "cogni-node-app-v1",
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
describe("comparative proof boundary", () => {
  it("rejects every private input before any IO", () => {
    for (const key of [
      "env",
      "sdl",
      "command",
      "sql",
      "namespace",
      "url",
      "leaseId",
      "selector",
      "logs",
    ]) {
      const value = requestFixture();
      Object.assign(value.expected.workloads[0]?.services[0] ?? {}, {
        [key]: "private",
      });
      expect(() => parseComputeProof(JSON.stringify(value))).toThrow();
    }
  });
  it("binds all parsed fields and nonce, including tuple and ordered arrays", () => {
    const value = parseComputeProof(JSON.stringify(requestFixture()));
    const hash = computeProofHash(value);
    for (const change of [
      (x: typeof value) => {
        x.nonce = "f".repeat(64);
      },
      (x: typeof value) => {
        x.expected.deploySha = "f".repeat(40);
      },
      (x: typeof value) => {
        if (x.expected.workloads[0])
          x.expected.workloads[0].leaseGeneration = 1;
      },
      (x: typeof value) => {
        const s = x.expected.workloads[0]?.services[0];
        if (s) s.memoryMi = 512;
      },
    ]) {
      const x = structuredClone(value);
      change(x);
      expect(computeProofHash(x)).not.toBe(hash);
    }
  });
  it("rejects unknown fields, duplicates, empty/unbound and oversized inventory", () => {
    const value = requestFixture();
    value.expected.workloads.push(required(value.expected.workloads[0]));
    expect(() => parseComputeProof(JSON.stringify(value))).toThrow();
    expect(() => parseComputeProof(" ".repeat(65537))).toThrow();
  });
});

import { vi } from "vitest";
import { stringify } from "yaml";
import { withDatabaseCaTrust } from "@/shared/secrets/database-ca-command";
import { NativeComputeReleaseProofAdapter } from "./native-proof";

/** Labeled injection harness ONLY. No Kubernetes/provider/allocation writes or runtime proof. */
function nativeHarness() {
  const input = parseComputeProof(JSON.stringify(requestFixture()));
  const e = input.expected,
    w = required(e.workloads[0]),
    service = required(w.services[0]),
    image = required(w.artifacts[0]).image;
  const { commandTemplate: _, bindings, ...nativeService } = service;
  const uid = "current-xr-uid",
    namespace = "cogni-candidate-a";
  const live = {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "XComputeWorkload",
    metadata: {
      name: e.nodeId,
      namespace,
      uid,
      generation: 7,
      labels: {
        "cogni.io/node-id": e.nodeId,
        "cogni.io/environment": "candidate-a",
        "cogni.io/node": "operator",
      },
    },
    spec: {
      nodeId: e.nodeId,
      environment: e.environment,
      bundle: {
        ref: e.bundleRef,
        source: { repository: e.repository, sha: e.sourceSha },
        artifacts: w.artifacts,
      },
      workload: {
        name: "operator",
        publicHost: w.publicHost,
        services: [{ ...nativeService, bindings: {} }],
      },
      leaseGeneration: 0,
      migration: { policy: "RequireBeforeServing" },
    },
    status: {
      phase: "Ready",
      serving: true,
      observedBundle: {
        ref: e.bundleRef,
        source: { repository: e.repository, sha: e.sourceSha },
      },
      conditions: [
        { type: "Ready", status: "True", observedGeneration: 7 },
        { type: "Synced", status: "True", observedGeneration: 7 },
      ],
    },
  };
  const phase = {
    name: "migrate",
    image,
    ...withDatabaseCaTrust([
      "/bin/sh",
      "-c",
      "exec node /app/app/migrate.mjs /app/app/migrations",
    ]),
    env: [
      { name: "NODE_NAME", value: "operator" },
      {
        name: "DATABASE_URL",
        valueFrom: {
          secretKeyRef: {
            name: "operator-compute-migration-secrets",
            key: "DATABASE_MIGRATION_URL",
          },
        },
      },
      {
        name: "DATABASE_SSL_CA_CERT",
        valueFrom: {
          secretKeyRef: {
            name: "operator-compute-migration-secrets",
            key: "DATABASE_SSL_CA_CERT",
            optional: true,
          },
        },
      },
    ],
  };
  const job = {
    metadata: {
      name: `migrate-operator-${"d".repeat(12)}`,
      namespace,
      uid: "job-now",
      annotations: { "cogni.io/bundle-digest": `sha256:${"d".repeat(64)}` },
      labels: {
        "cogni.io/node": "operator",
        "cogni.io/environment": "candidate-a",
        "app.kubernetes.io/managed-by": "compute-workload-controller",
      },
    },
    spec: { template: { spec: { containers: [phase] } } },
    status: { conditions: [{ type: "Complete", status: "True" }] },
  };
  const pod = {
    metadata: {
      name: "migration-pod-now",
      namespace,
      ownerReferences: [
        {
          uid: "job-now",
          annotations: { "cogni.io/bundle-digest": `sha256:${"d".repeat(64)}` },
          kind: "Job",
          controller: true,
        },
      ],
    },
    spec: { containers: [structuredClone(phase)] },
    status: {
      phase: "Succeeded",
      containerStatuses: [
        { name: "migrate", image, state: { terminated: { exitCode: 0 } } },
      ],
    },
  };
  let logs = `COGNI_MIGRATION_RECEIPT_V1 ${JSON.stringify({ node: "operator", declared: ["0000"], applied: [{ tag: "0000", hash: "9".repeat(64), appliedAtMs: 1 }] })}\n`;
  const kube = {
    json: vi.fn(async (path: string) => {
      if (path.includes("xcomputeworkloads")) return live;
      if (path.includes("/jobs/")) return job;
      if (path.includes("/pods?")) return { metadata: {}, items: [pod] };
      throw new Error("unexpected native read");
    }),
    log: vi.fn(async () => logs),
  };
  const allocation = {
    receiptId: "test-only-receipt",
    cogniKey: "xcw:cogni-candidate-a:test:0",
    identity: { nodeId: e.nodeId, compositeUid: uid, compositeGeneration: 7 },
    workload: "operator",
    environment: "candidate-a",
    state: "allocated" as const,
    externalName: "12345",
    providerAccount: "provider-owned",
  };
  const ledger = {
    readOwnedAllocations: vi.fn(
      async (
        _input: { nodeId: string; environment: string },
        _signal: AbortSignal
      ) => [allocation]
    ),
  };
  const sdl = {
    version: "2.0",
    services: {
      app: {
        image,
        env: ["HOST=0.0.0.0", "HOSTNAME=0.0.0.0", "PORT=3000"],
        expose: [
          {
            port: 3000,
            as: 80,
            accept: [w.publicHost],
            to: [{ global: true }],
          },
        ],
      },
    },
    profiles: {
      compute: {
        app: {
          resources: {
            cpu: { units: 100 },
            memory: { size: "256Mi" },
            storage: [{ size: "1Mi" }],
          },
        },
      },
    },
    deployment: { app: { cogni: { profile: "app", count: 1 } } },
  };
  const observed = {
    observedAt: new Date().toISOString(),
    leaseId: "12345",
    ownerAccount: "owner-owned",
    providerAccount: "provider-owned",
    providerSdl: stringify(sdl),
    providerSdlSha256: "PRIVATE-NEVER-RETURNED",
    consoleManifestVersion: "v1",
    chainManifestVersion: "v1",
    services: [
      {
        name: "app",
        observedGeneration: 7,
        // Test-only native observation injection. Console cannot supply this today.
        currentArtifact: { generation: 7, image },
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        total: 1,
        available: 1,
      },
    ],
  };
  const provider = { readManagedDefinition: vi.fn(async () => observed) };
  const adapter = new NativeComputeReleaseProofAdapter(kube, ledger, provider);
  return {
    input,
    live,
    job,
    pod,
    kube,
    ledger,
    provider,
    allocation,
    observed,
    sdl,
    adapter,
    setLogs: (text: string) => {
      logs = text;
    },
  };
}
describe("current native evidence (test-only injection)", () => {
  it("joins complete current XR/allocation/provider/Job/pod/receipt without returning raw state", async () => {
    const h = nativeHarness();
    const result = await h.adapter.sample(
      h.input,
      new AbortController().signal
    );
    expect(result.dimensions[0]).toEqual({
      workload: h.input.expected.nodeId,
      native: "verified",
      provider: "verified",
      migration: "verified",
      code: "verified",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-NEVER-RETURNED");
    expect(JSON.stringify(result)).not.toContain("job-now");
    expect(h.kube.log).toHaveBeenCalledOnce();
  });
  it("rejects wrong generation, identity, bundle and omitted native service before provider IO", async () => {
    for (const change of [
      (h: ReturnType<typeof nativeHarness>) => {
        h.live.metadata.labels["cogni.io/node-id"] = "foreign";
      },
      (h: ReturnType<typeof nativeHarness>) => {
        required(h.live.status.conditions[0]).observedGeneration = 6;
      },
      (h: ReturnType<typeof nativeHarness>) => {
        h.live.spec.bundle.source.sha = "f".repeat(40);
      },
      (h: ReturnType<typeof nativeHarness>) => {
        h.live.spec.workload.services = [];
      },
    ]) {
      const h = nativeHarness();
      change(h);
      const result = await h.adapter.sample(
        h.input,
        new AbortController().signal
      );
      expect(result.dimensions[0]?.native).not.toBe("verified");
      expect(h.provider.readManagedDefinition).not.toHaveBeenCalled();
    }
  });
  it("current failed/running Job beats old successful receipt; wrong owner UID/image/malformed last receipt is unavailable", async () => {
    for (const change of [
      (h: ReturnType<typeof nativeHarness>) => {
        h.job.status.conditions = [{ type: "Failed", status: "True" }];
      },
      (h: ReturnType<typeof nativeHarness>) => {
        h.job.status.conditions = [];
      },
      (h: ReturnType<typeof nativeHarness>) => {
        h.job.metadata.annotations["cogni.io/bundle-digest"] =
          `sha256:${"a".repeat(64)}`;
      },
      (h: ReturnType<typeof nativeHarness>) => {
        required(h.pod.metadata.ownerReferences[0]).uid = "job-old";
      },
      (h: ReturnType<typeof nativeHarness>) => {
        required(h.pod.status.containerStatuses[0]).image =
          `ghcr.io/cogni/app@sha256:${"f".repeat(64)}`;
      },
      (h: ReturnType<typeof nativeHarness>) => {
        h.setLogs("COGNI_MIGRATION_RECEIPT_V1 {bad}");
      },
    ]) {
      const h = nativeHarness();
      change(h);
      const result = await h.adapter.sample(
        h.input,
        new AbortController().signal
      );
      expect(result.dimensions[0]?.migration).not.toBe("verified");
    }
  });
  it("rejects ambiguous or foreign effective migration env on Job and owned pod independently", async () => {
    for (const target of ["job", "pod", "both"] as const) {
      for (const kind of [
        "ca-name",
        "ca-key",
        "ca-optional",
        "duplicate-db",
        "literal-db",
        "envFrom",
        "node",
      ]) {
        const h = nativeHarness();
        const mutate = (container: { env: unknown[] }) => {
          const env = container.env as Record<string, unknown>[];
          if (kind === "duplicate-db")
            env.push({
              name: "DATABASE_URL",
              value: "foreign-private-fixture",
            });
          if (kind === "literal-db")
            Object.assign(required(env[1]), {
              value: "foreign-private-fixture",
            });
          if (kind === "node")
            Object.assign(required(env[0]), { value: "foreign" });
          if (kind === "envFrom")
            Object.assign(container, {
              envFrom: [{ secretRef: { name: "foreign" } }],
            });
          if (kind.startsWith("ca-")) {
            const ca = required(env[2]) as {
              valueFrom: { secretKeyRef: Record<string, unknown> };
            };
            Object.assign(
              ca.valueFrom.secretKeyRef,
              kind === "ca-name"
                ? { name: "foreign" }
                : kind === "ca-key"
                  ? { key: "FOREIGN_CA" }
                  : { optional: false }
            );
          }
        };
        if (target !== "pod")
          mutate(required(h.job.spec.template.spec.containers[0]));
        if (target !== "job") mutate(required(h.pod.spec.containers[0]));
        const result = await h.adapter.sample(
          h.input,
          new AbortController().signal
        );
        expect(result.dimensions[0]?.migration, `${target}:${kind}`).toBe(
          "unavailable"
        );
        expect(h.kube.log).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("foreign-private-fixture");
      }
    }
  });
  it("requires current provider-native generation AND running image, never desired SDL or counters alone", async () => {
    for (const target of ["app", "worker"]) {
      for (const kind of ["absent", "old-generation", "old-image"]) {
        const h = nativeHarness();
        addPrivateSibling(h);
        const service = required(
          h.observed.services.find((x) => x.name === target)
        );
        if (kind === "absent")
          Object.assign(service, { currentArtifact: null });
        if (kind === "old-generation") service.observedGeneration = 1;
        if (kind === "old-image")
          service.currentArtifact.image = `ghcr.io/cogni/old@sha256:${"1".repeat(64)}`;
        const result = await h.adapter.sample(
          h.input,
          new AbortController().signal
        );
        expect(result.dimensions[0]?.provider, `${target}:${kind}`).toBe(
          "unavailable"
        );
        expect(result.dimensions[0]?.code).toBe("provider_unavailable");
      }
    }
  });
  it("provider wrong image/private exposure/rollout and unknown sealed command fail closed without SDL equality oracle", async () => {
    for (const change of [
      (h: ReturnType<typeof nativeHarness>) => {
        h.sdl.services.app.image = `ghcr.io/cogni/app@sha256:${"f".repeat(64)}`;
        h.observed.providerSdl = stringify(h.sdl);
      },
      (h: ReturnType<typeof nativeHarness>) => {
        required(h.observed.services[0]).readyReplicas = 0;
      },
      (h: ReturnType<typeof nativeHarness>) => {
        Object.assign(h.sdl.services.app, {
          command: ["sh", "-c", "private-secret"],
        });
        h.observed.providerSdl = stringify(h.sdl);
      },
    ]) {
      const h = nativeHarness();
      change(h);
      const result = await h.adapter.sample(
        h.input,
        new AbortController().signal
      );
      expect(result.dimensions[0]?.provider).not.toBe("verified");
      expect(JSON.stringify(result)).not.toContain("private-secret");
    }
  });
  it("covers private sibling services and rejects missing provider evidence for them", async () => {
    const h = nativeHarness();
    addPrivateSibling(h);
    expect(
      (await h.adapter.sample(h.input, new AbortController().signal))
        .dimensions[0]?.provider
    ).toBe("verified");
    h.observed.services.pop();
    expect(
      (await h.adapter.sample(h.input, new AbortController().signal))
        .dimensions[0]?.provider
    ).toBe("unavailable");
  });
  it("rejects wrong/missing public and private bind host, listen port and declared binding target", async () => {
    for (const target of ["app", "worker"]) {
      for (const bad of [
        "HOST=127.0.0.1",
        "HOSTNAME=127.0.0.1",
        "PORT=9999",
        "UPSTREAM_URL=http://foreign:9000",
      ]) {
        const h = nativeHarness();
        addPrivateSibling(h);
        const workload = required(h.input.expected.workloads[0]);
        const source = required(
          workload.services.find((service) => service.name === target)
        );
        source.bindings = [
          { key: "UPSTREAM_URL", service: target === "app" ? "worker" : "app" },
        ];
        Object.assign(
          required(
            h.live.spec.workload.services.find(
              (service) => service.name === target
            )
          ).bindings,
          { UPSTREAM_URL: target === "app" ? "worker" : "app" }
        );
        const services = h.sdl.services as Record<string, { env: string[] }>;
        const service = required(services[target]);
        service.env = [
          "HOST=0.0.0.0",
          "HOSTNAME=0.0.0.0",
          `PORT=${source.port}`,
          `UPSTREAM_URL=http://${target === "app" ? "worker:9000" : "app:3000"}`,
        ];
        h.observed.providerSdl = stringify(h.sdl);
        expect(
          (await h.adapter.sample(h.input, new AbortController().signal))
            .dimensions[0]?.provider
        ).toBe("verified");
        const key = bad.slice(0, bad.indexOf("="));
        service.env = service.env.filter(
          (entry) => !entry.startsWith(`${key}=`)
        );
        service.env.push(bad);
        h.observed.providerSdl = stringify(h.sdl);
        expect(
          (await h.adapter.sample(h.input, new AbortController().signal))
            .dimensions[0]?.provider
        ).toBe("unavailable");
        service.env = service.env.filter(
          (entry) => !entry.startsWith(`${key}=`)
        );
        h.observed.providerSdl = stringify(h.sdl);
        expect(
          (await h.adapter.sample(h.input, new AbortController().signal))
            .dimensions[0]?.provider
        ).toBe("unavailable");
      }
    }
  });
  it("passes the original abort to the owned allocation reader and fences original settlement", async () => {
    const h = nativeHarness(),
      controller = new AbortController();
    let stopped: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    h.ledger.readOwnedAllocations.mockImplementationOnce(
      async (_input, signal: AbortSignal) => {
        stopped();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => setTimeout(resolve, 25), {
            once: true,
          })
        );
        throw new Error("unavailable");
      }
    );
    const sample = h.adapter.sample(h.input, controller.signal);
    await entered;
    controller.abort();
    expect((await sample).dimensions[0]?.provider).toBe("unavailable");
    expect(h.provider.readManagedDefinition).not.toHaveBeenCalled();
  });
  it("does not invent k3s or forbidden native evidence", async () => {
    const h = nativeHarness();
    required(h.input.expected.workloads[0]).kind = "Deployment";
    expect(
      (await h.adapter.sample(h.input, new AbortController().signal))
        .dimensions[0]?.native
    ).toBe("unavailable");
    expect(h.kube.json).not.toHaveBeenCalled();
    const missing = nativeHarness();
    const noReader = new NativeComputeReleaseProofAdapter(
      missing.kube,
      undefined,
      missing.provider
    );
    expect(
      (await noReader.sample(missing.input, new AbortController().signal))
        .dimensions[0]?.provider
    ).toBe("unavailable");
    expect(missing.ledger.readOwnedAllocations).not.toHaveBeenCalled();
    expect(missing.provider.readManagedDefinition).not.toHaveBeenCalled();
    const forbidden = nativeHarness();
    forbidden.kube.json.mockRejectedValueOnce(
      new Error("private token and native URL must stay private")
    );
    const result = await forbidden.adapter.sample(
      forbidden.input,
      new AbortController().signal
    );
    expect(result.dimensions[0]?.code).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private token");
  });
  it("waits for original native read after abort and returns no late positive", async () => {
    const h = nativeHarness(),
      abort = new AbortController();
    let finish: () => void = () => {};
    const hold = new Promise<void>((r) => {
      finish = r;
    });
    h.kube.json.mockImplementationOnce(async () => {
      await hold;
      return h.live;
    });
    let settled = false;
    const sample = h.adapter.sample(h.input, abort.signal).then((x) => {
      settled = true;
      return x;
    });
    await Promise.resolve();
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    const result = await sample;
    expect(result.dimensions[0]?.native).toBe("unavailable");
    expect(h.provider.readManagedDefinition).not.toHaveBeenCalled();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("unavailable");
  return value;
}

function addPrivateSibling(h: ReturnType<typeof nativeHarness>) {
  const workload = required(h.input.expected.workloads[0]);
  const worker = {
    ...required(workload.services[0]),
    name: "worker",
    artifact: "worker",
    runtimeProfile: "image-default" as const,
    visibility: "private" as const,
    port: 9000,
  };
  workload.services.push(worker);
  workload.artifacts.push({
    name: "worker",
    image: `ghcr.io/cogni/worker@sha256:${"f".repeat(64)}`,
  });
  const { commandTemplate: _, bindings: __, ...declared } = worker;
  h.live.spec.workload.services.push({ ...declared, bindings: {} });
  Object.assign(h.sdl.services, {
    worker: {
      image: required(workload.artifacts[1]).image,
      env: ["HOST=0.0.0.0", "HOSTNAME=0.0.0.0", "PORT=9000"],
      expose: [{ port: 9000, as: 9000, to: [{ service: "app" }] }],
    },
  });
  Object.assign(h.sdl.profiles.compute, {
    worker: structuredClone(h.sdl.profiles.compute.app),
  });
  Object.assign(h.sdl.deployment, {
    worker: { cogni: { profile: "worker", count: 1 } },
  });
  h.observed.services.push({
    ...required(h.observed.services[0]),
    name: "worker",
    currentArtifact: {
      generation: 7,
      image: required(workload.artifacts[1]).image,
    },
  });
  h.observed.providerSdl = stringify(h.sdl);
}
