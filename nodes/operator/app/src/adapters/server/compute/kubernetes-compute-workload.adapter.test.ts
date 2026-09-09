// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CoordinationV1Api,
  CoreV1Api,
  CustomObjectsApi,
  V1ConfigMap,
  V1Lease,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { parse, parseDocument } from "yaml";

import type { ComputeWorkload } from "@/ports";

import {
  DEFAULT_LEASE_DURATION_SECONDS,
  KubernetesComputeWorkloadStateAdapter,
  KubernetesLeaseLeaderElector,
  type LeaseRenewError,
  renewLeadershipOrFence,
} from "./kubernetes-compute-workload.adapter";

function apiError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

function declaredWorkload(): ComputeWorkload {
  const digest = `sha256:${"b".repeat(64)}`;
  return {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "ComputeWorkload",
    metadata: {
      name: "123e4567-e89b-12d3-a456-426614174001",
      namespace: "cogni-candidate-a",
      uid: "123e4567-e89b-12d3-a456-426614174000",
      generation: 1,
      resourceVersion: "1",
      labels: {
        "cogni.io/node-id": "123e4567-e89b-12d3-a456-426614174001",
        "cogni.io/environment": "candidate-a",
        "cogni.io/node": "sample-node",
      },
    },
    spec: {
      nodeId: "123e4567-e89b-12d3-a456-426614174001",
      environment: "candidate-a",
      bundle: {
        ref: `ghcr.io/cogni-dao/sample-node-bundle@sha256:${"c".repeat(64)}`,
        source: { repository: "cogni-dao/sample-node", sha: "a".repeat(40) },
        artifacts: [
          { name: "app", image: `ghcr.io/cogni-dao/sample-node@${digest}` },
          {
            name: "echo-sidecar",
            image: `ghcr.io/cogni-dao/echo-sidecar@${digest}`,
          },
        ],
      },
      workload: {
        name: "sample-node",
        publicHost: "sample-node-test.cognidao.org",
        services: [
          {
            name: "app",
            artifact: "app",
            runtimeProfile: "cogni-node-app-v1",
            command: ["node"],
            args: ["server.mjs"],
            port: 3000,
            visibility: "public",
            bindings: { ECHO_SIDECAR_URL: "echo-sidecar" },
            bindHost: "0.0.0.0",
            cpuUnits: 0.5,
            memoryMi: 512,
            storageMi: 1024,
          },
          {
            name: "echo-sidecar",
            artifact: "echo-sidecar",
            port: 9100,
            visibility: "private",
            bindings: {},
            bindHost: "0.0.0.0",
            cpuUnits: 0.25,
            memoryMi: 256,
            storageMi: 512,
          },
        ],
      },
    },
  };
}

describe("ComputeWorkload Kubernetes contract", () => {
  it("pins the controller env order the per-env overlays patch positionally", async () => {
    // bug.5110 follow-up. Every infra/k8s/overlays/<env>/operator/kustomization.yaml
    // patches this container's env by INDEX
    // (`/spec/template/spec/containers/0/env/N/value`), so inserting a variable
    // above an existing one silently repoints a DIFFERENT variable. Adding the
    // lease knob ahead of AKASH_ALLOWED_PROVIDERS blanked that allowlist in all
    // three envs, and an empty allowlist rejects every provider bid -- no node
    // could obtain an Akash lease. Nothing else failed loudly, so pin the order:
    // append new variables, never insert.
    const deploymentYaml = await readFile(
      join(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../../../../../../infra/k8s/base/compute-workload-controller/deployment.yaml"
      ),
      "utf8"
    );
    const deployment = parse(deploymentYaml) as {
      spec: {
        strategy?: { type?: string };
        template: {
          spec: { containers: { env: { name: string }[] }[] };
        };
      };
    };
    const env = deployment.spec.template.spec.containers[0]?.env ?? [];
    expect(env.slice(0, 4).map((entry) => entry.name)).toEqual([
      "POD_NAMESPACE",
      "CONTROLLER_ENVIRONMENT",
      "DEPLOYMENT_DOMAIN",
      "AKASH_ALLOWED_PROVIDERS",
    ]);
    // Singleton by design: a RollingUpdate surge would run two pods against one
    // coordination Lease and manufacture the CAS conflicts this controller then
    // has to survive.
    expect(deployment.spec.strategy?.type).toBe("Recreate");
  });

  it("admits bounded topology fields and preserves service bindings over the API wire", async () => {
    // File-relative, never CWD-relative: the unit job and local runs invoke
    // vitest from different working directories.
    const crdYaml = await readFile(
      join(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../../../../../../infra/k8s/base/compute-workload-platform/crd.yaml"
      ),
      "utf8"
    );
    expect(parseDocument(crdYaml, { uniqueKeys: true }).errors).toEqual([]);
    const crd = parse(crdYaml) as {
      spec: {
        versions: {
          schema: { openAPIV3Schema: Record<string, unknown> };
        }[];
      };
    };
    const schema = crd.spec.versions[0]?.schema.openAPIV3Schema as {
      properties: {
        spec: {
          properties: {
            workload: {
              properties: {
                services: {
                  maxItems: number;
                  items: { properties: Record<string, unknown> };
                };
              };
            };
          };
        };
      };
    };
    const services =
      schema.properties.spec.properties.workload.properties.services;
    expect(services.maxItems).toBe(8);
    expect(services.items.properties).toHaveProperty("bindings");
    expect(services.items.properties).toHaveProperty("args");
    expect(services.items.properties).toHaveProperty("runtimeProfile");
    expect(crdYaml).toContain(
      "self.services.filter(s, s.visibility == 'public').size() == 1"
    );
    expect(crdYaml).toContain(
      "runtimeProfile is allowed only on the public service"
    );
    expect(crdYaml).toContain(
      "every binding must target a different declared sibling service"
    );
    // Label↔spec equality CANNOT be a CRD CEL rule (metadata.labels is
    // outside CRD CEL scope — the API server rejects the whole CRD). The
    // single-writer materializer + the controller's label-then-spec selection
    // own that invariant; only metadata.name is CEL-enforceable.
    expect(crdYaml).toContain(
      "metadata.name must equal spec.nodeId (one paid workload per node/env namespace)"
    );
    expect(crdYaml).not.toContain("self.metadata.labels");
    expect(
      (schema.properties.spec.properties as Record<string, unknown>).bundle
    ).toBeDefined();

    const resource = declaredWorkload();
    const custom = {
      listNamespacedCustomObject: vi.fn(async () => ({
        body: JSON.parse(JSON.stringify({ items: [resource] })),
      })),
    } as unknown as CustomObjectsApi;
    const state = new KubernetesComputeWorkloadStateAdapter(
      custom,
      {} as CoreV1Api,
      "cogni-candidate-a",
      "test-controller"
    );

    const [roundTripped] = await state.list();
    expect(roundTripped?.spec.workload.services[0]).toMatchObject({
      args: ["server.mjs"],
      runtimeProfile: "cogni-node-app-v1",
      bindings: { ECHO_SIDECAR_URL: "echo-sidecar" },
    });
  });

  it("claims a provider mutation with metadata.resourceVersion CAS", async () => {
    const patchNamespacedCustomObject = vi.fn(async () => ({ body: {} }));
    const custom = {
      patchNamespacedCustomObject,
    } as unknown as CustomObjectsApi;
    const state = new KubernetesComputeWorkloadStateAdapter(
      custom,
      {} as CoreV1Api,
      "cogni-candidate-a",
      "test-controller"
    );
    await expect(
      state.claimAttempt({
        resource: declaredWorkload(),
        receipt: '{"key":"one"}',
      })
    ).resolves.toBe(true);
    expect(patchNamespacedCustomObject).toHaveBeenCalledWith(
      "compute.cogni.io",
      "v1alpha1",
      "cogni-candidate-a",
      "computeworkloads",
      "123e4567-e89b-12d3-a456-426614174001",
      expect.objectContaining({
        metadata: expect.objectContaining({
          resourceVersion: "1",
          annotations: { "compute.cogni.io/last-attempt": '{"key":"one"}' },
        }),
      }),
      undefined,
      "compute-workload-controller",
      undefined,
      expect.any(Object)
    );

    patchNamespacedCustomObject.mockRejectedValueOnce(apiError(409));
    await expect(
      state.claimAttempt({ resource: declaredWorkload(), receipt: "other" })
    ).resolves.toBe(false);
  });

  it("deletes a stale failure when status becomes healthy", async () => {
    const patchNamespacedCustomObjectStatus = vi.fn(async () => ({ body: {} }));
    const state = new KubernetesComputeWorkloadStateAdapter(
      { patchNamespacedCustomObjectStatus } as unknown as CustomObjectsApi,
      {} as CoreV1Api,
      "cogni-candidate-a",
      "test-controller"
    );

    await state.patchStatus({
      resource: declaredWorkload(),
      status: {
        phase: "Ready",
        desiredGeneration: 1,
        observedGeneration: 1,
        conditions: [],
      },
    });

    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      "compute.cogni.io",
      "v1alpha1",
      "cogni-candidate-a",
      "computeworkloads",
      "123e4567-e89b-12d3-a456-426614174001",
      { status: expect.objectContaining({ phase: "Ready", failure: null }) },
      undefined,
      "compute-workload-controller",
      undefined,
      expect.any(Object)
    );
  });

  it("holds one durable wallet-wide allocation across competing workload reconciles", async () => {
    let ledger = {
      metadata: {
        name: "compute-workload-allocation-ledger",
        namespace: "cogni-candidate-a",
        resourceVersion: "1",
      },
      data: {} as Record<string, string>,
    };
    const core = {
      readNamespacedConfigMap: vi.fn(async () => ({
        body: structuredClone(ledger),
      })),
      replaceNamespacedConfigMap: vi.fn(async (_name, _namespace, body) => {
        ledger = {
          metadata: {
            ...ledger.metadata,
            resourceVersion: String(
              Number(ledger.metadata.resourceVersion) + 1
            ),
          },
          data: { ...(body.data ?? {}) },
        };
        return { body: structuredClone(ledger) };
      }),
    } as unknown as CoreV1Api;
    const state = new KubernetesComputeWorkloadStateAdapter(
      {} as CustomObjectsApi,
      core,
      "cogni-candidate-a",
      "test-controller"
    );

    await expect(
      state.claimWalletAllocation({ attemptKey: "a", workloadUid: "uid-a" })
    ).resolves.toEqual({ state: "claimed" });
    await state.prepareWalletAllocation({
      attemptKey: "a",
      allocationCursor: "41",
    });
    await expect(
      state.claimWalletAllocation({ attemptKey: "a", workloadUid: "uid-a" })
    ).resolves.toEqual({ state: "owned", allocationCursor: "41" });
    await expect(
      state.claimWalletAllocation({ attemptKey: "b", workloadUid: "uid-b" })
    ).resolves.toEqual({ state: "blocked", ownerAttemptKey: "a" });
    await state.completeWalletAllocation({ attemptKey: "a" });
    await expect(
      state.claimWalletAllocation({ attemptKey: "b", workloadUid: "uid-b" })
    ).resolves.toEqual({ state: "claimed" });
  });

  it("creates the runtime ledger outside Argo ownership before first allocation", async () => {
    let ledger:
      | {
          metadata: {
            name: string;
            namespace: string;
            resourceVersion: string;
          };
          data: Record<string, string>;
        }
      | undefined;
    const core = {
      readNamespacedConfigMap: vi.fn(async () => {
        if (!ledger) throw apiError(404);
        return { body: structuredClone(ledger) };
      }),
      createNamespacedConfigMap: vi.fn(
        async (_namespace: string, body: V1ConfigMap) => {
          ledger = {
            metadata: {
              name: body.metadata?.name ?? "",
              namespace: body.metadata?.namespace ?? "",
              resourceVersion: "1",
            },
            data: {},
          };
          return { body: structuredClone(ledger) };
        }
      ),
      replaceNamespacedConfigMap: vi.fn(
        async (_name: string, _namespace: string, body: V1ConfigMap) => {
          ledger = {
            metadata: {
              name: body.metadata?.name ?? "",
              namespace: body.metadata?.namespace ?? "",
              resourceVersion: "2",
            },
            data: { ...(body.data ?? {}) },
          };
          return { body: structuredClone(ledger) };
        }
      ),
    } as unknown as CoreV1Api;
    const state = new KubernetesComputeWorkloadStateAdapter(
      {} as CustomObjectsApi,
      core,
      "cogni-candidate-a",
      "test-controller"
    );

    await expect(
      state.claimWalletAllocation({ attemptKey: "a", workloadUid: "uid-a" })
    ).resolves.toEqual({ state: "claimed" });
    expect(core.createNamespacedConfigMap).toHaveBeenCalledOnce();
  });
});

describe("KubernetesLeaseLeaderElector", () => {
  it("creates the lease when absent and renews without blocking reconciles", async () => {
    const createNamespacedLease = vi.fn(async () => ({ body: {} }));
    const api = {
      readNamespacedLease: vi.fn(async () => {
        throw apiError(404);
      }),
      createNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );

    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:00.226Z"))
    ).resolves.toEqual({ held: true });
    expect(elector.isLeader()).toBe(true);
    expect(createNamespacedLease).toHaveBeenCalledWith(
      "cogni-candidate-a",
      expect.objectContaining({
        spec: expect.objectContaining({
          holderIdentity: "pod-a",
          // MicroTime: the API server 400s anything without exactly six
          // fractional digits; the 0.22 client serializes Date with three.
          acquireTime: "2026-09-01T12:00:00.226000Z",
          renewTime: "2026-09-01T12:00:00.226000Z",
        }),
      })
    );
  });

  it("refuses an unexpired lease held by another replica", async () => {
    const existing: V1Lease = {
      metadata: { resourceVersion: "7" },
      spec: {
        holderIdentity: "pod-b",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
      },
    };
    const replaceNamespacedLease = vi.fn();
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: existing })),
      replaceNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );

    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:10.000Z"))
    ).resolves.toEqual({ held: false, reason: "foreign_holder" });
    expect(replaceNamespacedLease).not.toHaveBeenCalled();
  });

  it("takes over only after the prior holder's lease expires", async () => {
    const existing: V1Lease = {
      metadata: { resourceVersion: "7" },
      spec: {
        holderIdentity: "pod-b",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 2,
      },
    };
    const replaceNamespacedLease = vi.fn(async () => ({ body: {} }));
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: existing })),
      replaceNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );

    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:31.000Z"))
    ).resolves.toEqual({ held: true });
    expect(replaceNamespacedLease).toHaveBeenCalledWith(
      "compute-workload-controller",
      "cogni-candidate-a",
      expect.objectContaining({
        metadata: expect.objectContaining({ resourceVersion: "7" }),
        spec: expect.objectContaining({
          holderIdentity: "pod-a",
          leaseTransitions: 3,
        }),
      })
    );
  });

  it("keeps the renewal window open across a transient API error until it expires", async () => {
    const lease: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 1,
      },
    };
    const readNamespacedLease = vi.fn(async () => ({ body: lease }));
    const api = {
      readNamespacedLease,
      replaceNamespacedLease: vi.fn(async () => ({ body: lease })),
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );

    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"))
    ).resolves.toEqual({ held: true });

    readNamespacedLease.mockRejectedValueOnce(apiError(503));
    await expect(elector.acquireOrRenew()).rejects.toBeTruthy();

    // Nobody else can take the Lease before it expires, so this process still holds it.
    expect(elector.leaseHeldThrough(new Date("2026-09-01T12:00:29.000Z"))).toBe(
      true
    );
    expect(elector.leaseHeldThrough(new Date("2026-09-01T12:00:31.000Z"))).toBe(
      false
    );
  });

  it("closes the renewal window as soon as another replica definitively holds the lease", async () => {
    const mine: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 1,
      },
    };
    const readNamespacedLease = vi.fn(async () => ({ body: mine }));
    const api = {
      readNamespacedLease,
      replaceNamespacedLease: vi.fn(async () => ({ body: mine })),
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );

    await elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"));
    readNamespacedLease.mockResolvedValueOnce({
      body: {
        metadata: { resourceVersion: "10" },
        spec: {
          holderIdentity: "pod-b",
          renewTime: new Date("2026-09-01T12:00:05.000Z"),
          leaseDurationSeconds: 30,
          leaseTransitions: 2,
        },
      },
    });

    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:06.000Z"))
    ).resolves.toEqual({ held: false, reason: "foreign_holder" });
    expect(elector.leaseHeldThrough(new Date("2026-09-01T12:00:06.000Z"))).toBe(
      false
    );
  });

  it("survives five consecutive renew failures inside the deadline and fences past it", async () => {
    const lease: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 1,
      },
    };
    const readNamespacedLease = vi.fn(async () => ({ body: lease }));
    const api = {
      readNamespacedLease,
      replaceNamespacedLease: vi.fn(async () => ({ body: lease })),
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );
    const fence = vi.fn((_cause: LeaseRenewError): never => {
      throw new Error("fenced");
    });

    await elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"));

    // The production symptom: a saturated k3s API server drops the 5s renew calls.
    // Five in a row still sit inside the 30s deadline, so none of them may fence.
    for (let tick = 1; tick <= 5; tick += 1) {
      readNamespacedLease.mockRejectedValueOnce(apiError(503));
      const at = new Date(
        `2026-09-01T12:00:${String(tick * 5).padStart(2, "0")}.000Z`
      );
      await expect(
        renewLeadershipOrFence(
          {
            isLeader: () => elector.isLeader(),
            acquireOrRenew: () => elector.acquireOrRenew(at),
            leaseHeldThrough: () => elector.leaseHeldThrough(at),
          },
          fence
        )
      ).rejects.toBeTruthy();
      expect(elector.isLeader()).toBe(true);
    }
    expect(fence).not.toHaveBeenCalled();

    // Past the deadline with no successful renew, another replica may take over: fence.
    readNamespacedLease.mockRejectedValueOnce(apiError(503));
    const past = new Date("2026-09-01T12:00:31.000Z");
    await expect(
      renewLeadershipOrFence(
        {
          isLeader: () => elector.isLeader(),
          acquireOrRenew: () => elector.acquireOrRenew(past),
          leaseHeldThrough: () => elector.leaseHeldThrough(past),
        },
        fence
      )
    ).rejects.toThrow("fenced");
    expect(fence).toHaveBeenCalledOnce();

    // A recovered API renews normally without a lease transition.
    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:32.000Z"))
    ).resolves.toEqual({ held: true });
    expect(elector.currentEpoch()).toBe("1:pod-a");
  });

  it("guards dispatch with the live holder identity and lease-transition epoch", async () => {
    const lease: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 4,
      },
    };
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: lease })),
      replaceNamespacedLease: vi.fn(async () => ({ body: lease })),
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      // Pinned: these timelines predate the 120s default and assert a 30s window.
      30
    );
    await elector.acquireOrRenew(new Date("2026-09-01T12:00:05.000Z"));
    expect(elector.currentEpoch()).toBe("4:pod-a");
    await expect(
      elector.stillHolds("4:pod-a", new Date("2026-09-01T12:00:06.000Z"))
    ).resolves.toBe(true);
    await expect(
      elector.stillHolds("3:pod-a", new Date("2026-09-01T12:00:06.000Z"))
    ).resolves.toBe(false);
  });

  it("holds leadership through a CAS conflict inside the earned window (bug.5110)", async () => {
    // THE regression. A 409 on replace means our cached resourceVersion went stale on a
    // loaded API server — not that anyone took the lease. Dropping `leader` here paused
    // reconciliation AND made the next tick see `previouslyHeld === false`, erasing the
    // signal a genuine loss would otherwise raise.
    const mine: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 1,
      },
    };
    const replaceNamespacedLease = vi.fn(async () => ({ body: mine }));
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: mine })),
      replaceNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      30
    );

    await elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"));
    expect(elector.currentEpoch()).toBe("1:pod-a");

    replaceNamespacedLease.mockRejectedValueOnce(apiError(409));
    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:10.000Z"))
    ).resolves.toEqual({ held: false, reason: "cas_conflict" });

    // Still leader, still dispatchable: `stillHolds()` re-reads the live lease before any
    // provider mutation, so keeping the epoch cannot let a stale process write.
    expect(elector.isLeader()).toBe(true);
    expect(elector.currentEpoch()).toBe("1:pod-a");
    expect(elector.leaseHeldThrough(new Date("2026-09-01T12:00:29.000Z"))).toBe(
      true
    );
  });

  it("reports a CAS conflict past the deadline as expired, not as a conflict", async () => {
    const mine: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: 30,
        leaseTransitions: 1,
      },
    };
    const replaceNamespacedLease = vi.fn(async () => ({ body: mine }));
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: mine })),
      replaceNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a",
      30
    );

    await elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"));
    replaceNamespacedLease.mockRejectedValueOnce(apiError(409));
    await expect(
      elector.acquireOrRenew(new Date("2026-09-01T12:00:31.000Z"))
    ).resolves.toEqual({ held: false, reason: "expired" });
    expect(elector.isLeader()).toBe(false);
  });

  it("tolerates a long conflict storm at the default deadline without fencing", async () => {
    // Production shape: 24 consecutive failed renewals on the 10s derived tick still sit
    // inside the 120s default deadline. At replicas:1 nobody can take over, so none of
    // them may fence — the old 30s deadline fenced after six.
    const mine: V1Lease = {
      metadata: { resourceVersion: "9" },
      spec: {
        holderIdentity: "pod-a",
        renewTime: new Date("2026-09-01T12:00:00.000Z"),
        leaseDurationSeconds: DEFAULT_LEASE_DURATION_SECONDS,
        leaseTransitions: 1,
      },
    };
    const replaceNamespacedLease = vi.fn(async () => ({ body: mine }));
    const api = {
      readNamespacedLease: vi.fn(async () => ({ body: mine })),
      replaceNamespacedLease,
    } as unknown as CoordinationV1Api;
    const elector = new KubernetesLeaseLeaderElector(
      api,
      "cogni-candidate-a",
      "compute-workload-controller",
      "pod-a"
    );
    const fence = vi.fn((_cause: LeaseRenewError): never => {
      throw new Error("fenced");
    });

    await elector.acquireOrRenew(new Date("2026-09-01T12:00:00.000Z"));
    for (let tick = 1; tick <= 11; tick += 1) {
      replaceNamespacedLease.mockRejectedValueOnce(apiError(409));
      const at = new Date(
        `2026-09-01T12:0${tick < 6 ? "0" : "1"}:${String((tick * 10) % 60).padStart(2, "0")}.000Z`
      );
      await expect(
        renewLeadershipOrFence(
          {
            isLeader: () => elector.isLeader(),
            acquireOrRenew: () => elector.acquireOrRenew(at),
            leaseHeldThrough: () => elector.leaseHeldThrough(at),
          },
          fence
        )
      ).rejects.toMatchObject({ reason: "cas_conflict" });
      expect(elector.isLeader()).toBe(true);
    }
    expect(fence).not.toHaveBeenCalled();
  });
});

describe("renewLeadershipOrFence", () => {
  it("fences immediately when a different identity holds a live lease", async () => {
    const fenced = new Error("process fenced");
    const onLeadershipLost = vi.fn((_cause: LeaseRenewError): never => {
      throw fenced;
    });
    // `foreign_holder` is the one outcome that needs no deadline arithmetic: a replacement
    // leader is already reconciling, so this process must stop even if its own earned
    // window has not lapsed. Waiting out the deadline here would allow two writers.
    const lease = {
      isLeader: () => true,
      acquireOrRenew: vi.fn(async () => ({
        held: false as const,
        reason: "foreign_holder" as const,
      })),
      leaseHeldThrough: () => true,
    };

    await expect(renewLeadershipOrFence(lease, onLeadershipLost)).rejects.toBe(
      fenced
    );
    expect(onLeadershipLost).toHaveBeenCalledOnce();
    expect(onLeadershipLost.mock.calls[0]?.[0]).toMatchObject({
      reason: "foreign_holder",
    });
  });

  it("does not fence a CAS conflict, and names it so the log can discriminate", async () => {
    // bug.5110: this is the routine slow-API case. Fencing here crashlooped a
    // single-replica controller and stranded in-flight provider IO as an unresolvable
    // `prepared` attempt.
    const onLeadershipLost = vi.fn((_cause: LeaseRenewError): never => {
      throw new Error("must not fence");
    });
    const lease = {
      isLeader: () => true,
      acquireOrRenew: vi.fn(async () => ({
        held: false as const,
        reason: "cas_conflict" as const,
      })),
      leaseHeldThrough: () => true,
    };

    await expect(
      renewLeadershipOrFence(lease, onLeadershipLost)
    ).rejects.toMatchObject({
      name: "LeaseRenewError",
      reason: "cas_conflict",
    });
    expect(onLeadershipLost).not.toHaveBeenCalled();
  });

  it("fences once the earned deadline lapses with no successful renewal", async () => {
    const fenced = new Error("process fenced");
    const onLeadershipLost = vi.fn((_cause: LeaseRenewError): never => {
      throw fenced;
    });
    const lease = {
      isLeader: () => true,
      acquireOrRenew: vi.fn(async () => ({
        held: false as const,
        reason: "expired" as const,
      })),
      leaseHeldThrough: () => false,
    };

    await expect(renewLeadershipOrFence(lease, onLeadershipLost)).rejects.toBe(
      fenced
    );
    expect(onLeadershipLost.mock.calls[0]?.[0]).toMatchObject({
      reason: "expired",
    });
  });

  it("fences a prior leader when renewal errors past the deadline but not an ordinary follower", async () => {
    const failure = new Error("API unavailable past lease deadline");
    const fenced = new Error("process fenced");
    const priorLeaderFence = vi.fn((_cause: LeaseRenewError): never => {
      throw fenced;
    });
    await expect(
      renewLeadershipOrFence(
        {
          isLeader: () => true,
          acquireOrRenew: async () => {
            throw failure;
          },
          leaseHeldThrough: () => false,
        },
        priorLeaderFence
      )
    ).rejects.toBe(fenced);
    // The raw cause is preserved in the message so the fence log stays diagnosable —
    // a fence carrying only `causeType: "Error"` cost ~40 min of debugging in prod.
    expect(priorLeaderFence.mock.calls[0]?.[0]).toMatchObject({
      reason: "expired",
    });
    expect(priorLeaderFence.mock.calls[0]?.[0]?.message).toContain(
      "API unavailable past lease deadline"
    );

    const followerFence = vi.fn((_cause: LeaseRenewError): never => {
      throw new Error("follower must not be fenced");
    });
    await expect(
      renewLeadershipOrFence(
        {
          isLeader: () => false,
          acquireOrRenew: async () => ({
            held: false as const,
            reason: "foreign_holder" as const,
          }),
          leaseHeldThrough: () => false,
        },
        followerFence
      )
    ).resolves.toBe(false);
    expect(followerFence).not.toHaveBeenCalled();
  });

  it("does not fence a transient renewal error inside the unexpired lease window", async () => {
    const failure = new Error("socket hang up");
    const fence = vi.fn((_cause: LeaseRenewError): never => {
      throw new Error("must not fence a lease nobody else can take");
    });

    await expect(
      renewLeadershipOrFence(
        {
          isLeader: () => true,
          acquireOrRenew: async () => {
            throw failure;
          },
          leaseHeldThrough: () => true,
        },
        fence
      )
    ).rejects.toBe(failure);
    expect(fence).not.toHaveBeenCalled();
  });
});
