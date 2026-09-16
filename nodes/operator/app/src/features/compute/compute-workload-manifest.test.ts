// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  bootPolicyForEnvironment,
  buildComputeWorkloadManifest,
  computeWorkloadManifestFile,
} from "./compute-workload-manifest";
import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "./node-services-workload-spec";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const BUNDLE_DIGEST = "c".repeat(64);
const NODE_ID = "72aa130b-f0ad-495a-a061-9ee1f9c9525d";
const REQUIRED_SECRET_REFS = COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map(
  (key) => ({ key })
);

const bundle: ResolvedNodeArtifactBundle = {
  nodeId: NODE_ID,
  source: { repository: "cogni-dao/toks4", sha: SHA },
  artifacts: [
    { name: "web", image: `ghcr.io/cogni-dao/toks4-web@sha256:${DIGEST}` },
    {
      name: "worker",
      image: `ghcr.io/cogni-dao/toks4-worker@sha256:${"d".repeat(64)}`,
    },
  ],
  services: [
    {
      artifact: "web",
      image: `ghcr.io/cogni-dao/toks4-web@sha256:${DIGEST}`,
      service: {
        name: "web",
        artifact: {
          name: "web",
          context: ".",
          dockerfile: "Dockerfile",
          target: "runner",
        },
        port: 3200,
        visibility: "public",
        runtimeProfile: "cogni-node-app-v1",
        bindings: { WORKER_URL: "worker" },
        secretRefs: REQUIRED_SECRET_REFS,
        bindHost: "0.0.0.0",
        internalUrl: "http://web:3200",
        resources: { cpuUnits: 0.5, memoryMi: 1024, storageMi: 2048 },
      },
    },
    {
      artifact: "worker",
      image: `ghcr.io/cogni-dao/toks4-worker@sha256:${"d".repeat(64)}`,
      service: {
        name: "worker",
        artifact: {
          name: "worker",
          context: ".",
          dockerfile: "Dockerfile",
          target: "worker",
        },
        port: 9100,
        visibility: "private",
        bindings: {},
        secretRefs: [],
        bindHost: "0.0.0.0",
        internalUrl: "http://worker:9100",
        resources: { cpuUnits: 0.25, memoryMi: 256, storageMi: 512 },
      },
    },
  ],
};

describe("buildComputeWorkloadManifest", () => {
  it("renders source-bound artifacts and generic private service networking", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4-test.cognidao.org",
      computeApi: "legacy",
      leaseEpoch: 0,
    });

    expect(manifest.metadata).toEqual({
      name: NODE_ID,
      namespace: "cogni-candidate-a",
      labels: {
        "cogni.io/node-id": NODE_ID,
        "cogni.io/environment": "candidate-a",
        "cogni.io/node": "toks4",
      },
    });
    expect(manifest.spec.bundle).toEqual({
      ref: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      source: bundle.source,
      artifacts: bundle.artifacts,
    });
    expect(manifest.spec.workload.services).toEqual([
      expect.objectContaining({
        name: "web",
        artifact: "web",
        port: 3200,
        visibility: "public",
        runtimeProfile: "cogni-node-app-v1",
        bindings: { WORKER_URL: "worker" },
        bindHost: "0.0.0.0",
        secretRefs: REQUIRED_SECRET_REFS,
      }),
      expect.objectContaining({
        name: "worker",
        artifact: "worker",
        port: 9100,
        visibility: "private",
        bindings: {},
        bindHost: "0.0.0.0",
      }),
    ]);
    expect(manifest.spec.workload.publicHost).toBe("toks4-test.cognidao.org");
    expect(manifest.spec.workload.services[0]).not.toHaveProperty("image");
    expect(manifest.spec.workload.services[0]).not.toHaveProperty("env");
    expect(manifest.spec.workload.services[0]).not.toHaveProperty("expose");
  });

  it("rejects a mutable OCI bundle tag", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "candidate-a",
        bundleRef: `ghcr.io/cogni-dao/toks4:bundle-sha-${SHA}`,
        bundle,
        publicHost: "toks4-test.cognidao.org",
        computeApi: "legacy",
        leaseEpoch: 0,
      })
    ).toThrow("digest-pinned OCI reference");
  });

  it("rejects an incomplete runtime profile before rendering desired state", () => {
    const incompleteBundle: ResolvedNodeArtifactBundle = {
      ...bundle,
      services: bundle.services.map(({ service, ...resolved }, index) => ({
        ...resolved,
        service:
          index === 0
            ? { ...service, secretRefs: [{ key: "AUTH_SECRET" }] }
            : service,
      })),
    };

    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "candidate-a",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle: incompleteBundle,
        publicHost: "toks4-test.cognidao.org",
        computeApi: "legacy",
        leaseEpoch: 0,
      })
    ).toThrow(/cogni-node-app-v1 is missing secret_refs/);
  });

  it("emits the legacy kind with no Crossplane-only policy fields", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4-test.cognidao.org",
      computeApi: "legacy",
      leaseEpoch: 0,
    });

    expect(manifest.kind).toBe("ComputeWorkload");
    expect(manifest.spec).not.toHaveProperty("migration");
    expect(manifest.spec).not.toHaveProperty("bootPolicy");
    expect(manifest.spec).not.toHaveProperty("dns");
    expect(manifest.spec).not.toHaveProperty("leaseEpoch");
  });

  it("emits the Crossplane composite with the policies the XRD made declarative", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseEpoch: 2,
      dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      runtime: { substrateHost: "cogni.vm.cognidao.org" },
    });

    expect(manifest.kind).toBe("XComputeWorkload");
    expect(manifest.apiVersion).toBe("compute.cogni.io/v1alpha1");
    // Empty-birth ordering is stated, not inherited from the XRD default (bug.5116).
    expect(manifest.spec).toMatchObject({
      migration: { policy: "RequireBeforeTransaction" },
      bootPolicy: { onDeadline: "Hold" },
      leaseEpoch: 2,
      dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      runtime: { substrateHost: "cogni.vm.cognidao.org" },
    });
  });

  /**
   * THE REPLACEMENT PATH (story.5016). The actuator refuses to re-spend a settled idempotence
   * key (`akash_tx_create_refused_settled_key`), so a terminally closed lease makes its
   * (node, environment) unrecreatable until the epoch moves — and the epoch is emitted
   * EXPLICITLY, 0 included, so the desired state never leans on the XRD default and a catalog
   * bump is a visible one-line diff on the deploy branch.
   */
  it("emits the catalog lease epoch explicitly, even at zero", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseEpoch: 0,
    });

    expect(manifest.spec).toHaveProperty("leaseEpoch", 0);
  });

  it("refuses a nonzero lease epoch on the legacy authority, which reads no epoch", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "legacy",
        leaseEpoch: 1,
      })
    ).toThrow(/carried only by the crossplane authority/);
  });

  /**
   * THE MIS-WIRE GUARD (story.5016 step 8). The substrate answers on 7233/6379/4000; the public
   * apex is Cloudflare-proxied and drops all three. It is also the other hostname in scope at
   * every call site, so passing it is the plausible mistake — and one that renders, syncs and
   * buys a lease before the node fails its first Temporal call. Refuse it at build time.
   */
  it("refuses a substrate host that is the node's own public host", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "crossplane",
        leaseEpoch: 0,
        runtime: { substrateHost: "toks4.cognidao.org" },
      })
    ).toThrow(/environment VM host/);
  });

  it("refuses a substrate host that is not a hostname", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "crossplane",
        leaseEpoch: 0,
        runtime: { substrateHost: "http://cogni.vm.cognidao.org:7233" },
      })
    ).toThrow(/RFC-1123 hostname/);
  });

  /**
   * Absent runtime topology remains a SUPPORTED state: the composite omits the substrate env
   * block rather than guessing, degrading exactly like the legacy controller did on an
   * unparseable DSN. The deploy lane always supplies it (the composite action derives it with
   * vm_host_for_env), so this covers a caller that genuinely has no substrate to name.
   */
  it("omits runtime topology rather than deriving a substrate host", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseEpoch: 0,
    });

    expect(manifest.spec).not.toHaveProperty("runtime");
    expect(manifest.spec).not.toHaveProperty("dns");
  });

  /**
   * ONE_SEAM_TWO_CALLERS. The entire point of the seam is that flipping the authority changes
   * WHO reconciles and nothing about WHAT is deployed. A drift here — a differently-shaped
   * bundle, host, or service list on one arm — would make the Crossplane cutover a silent
   * redeploy of something else.
   */
  it("renders byte-identical identity, bundle, and topology across both authorities", () => {
    const base = {
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      leaseEpoch: 0,
    } as const;
    const legacy = buildComputeWorkloadManifest({
      ...base,
      computeApi: "legacy",
    });
    const crossplane = buildComputeWorkloadManifest({
      ...base,
      computeApi: "crossplane",
    });

    expect(crossplane.metadata).toEqual(legacy.metadata);
    const { migration, bootPolicy, leaseEpoch, ...shared } =
      crossplane.spec as unknown as Record<string, unknown>;
    expect(shared).toEqual(legacy.spec);
    expect(migration).toBeDefined();
    expect(bootPolicy).toBeDefined();
    expect(leaseEpoch).toBe(0);
  });

  it("refuses DNS intent on the legacy authority, which resolves its own zone", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "legacy",
        leaseEpoch: 0,
        dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      })
    ).toThrow(/carried only by the crossplane authority/);
  });
});

describe("bootPolicyForEnvironment", () => {
  /**
   * BOOT_SLO_OR_CLOSE. A candidate that never serves its exact SHA has no forensic value
   * worth renting; a live environment that stops serving is an incident to inspect. This is
   * the whole reason story.5025's transient candidate cannot leak spend.
   */
  it("closes a never-served candidate lease and holds every live environment", () => {
    expect(bootPolicyForEnvironment("candidate-a")).toEqual({
      onDeadline: "Close",
    });
    expect(bootPolicyForEnvironment("preview")).toEqual({ onDeadline: "Hold" });
    expect(bootPolicyForEnvironment("production")).toEqual({
      onDeadline: "Hold",
    });
  });
});

describe("computeWorkloadManifestFile", () => {
  /**
   * ONE_AUTHORITY_PER_WORKLOAD, structural half. The deploy-branch writer rsyncs the
   * materializer's output with `--delete`, so distinct filenames mean the authority not
   * selected leaves git in the same commit the selected one arrives in. Identical filenames
   * would make a half-applied cutover indistinguishable from a complete one.
   */
  it("gives each authority its own file so the other cannot survive the rsync", () => {
    expect(computeWorkloadManifestFile("legacy")).toBe("compute-workload.yaml");
    expect(computeWorkloadManifestFile("crossplane")).toBe(
      "xcomputeworkload.yaml"
    );
    expect(computeWorkloadManifestFile("legacy")).not.toBe(
      computeWorkloadManifestFile("crossplane")
    );
  });
});
