// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  bootPolicyForEnvironment,
  buildComputeWorkloadManifest,
  computeWorkloadManifestFile,
} from "./compute-workload-manifest";
import { deploymentEnvironmentSchema } from "./node-deployment-provider";
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
      leaseGeneration: 0,
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
        leaseGeneration: 0,
      })
    ).toThrow("digest-pinned OCI reference");
  });

  it("supplies the profile's secret_refs so a spec that predates a key still renders (bug.5175)", () => {
    // A stale spec that declares only AUTH_SECRET — the shape that blocked toks5 PR#2.
    const staleBundle: ResolvedNodeArtifactBundle = {
      ...bundle,
      services: bundle.services.map(({ service, ...resolved }, index) => ({
        ...resolved,
        service:
          index === 0
            ? { ...service, secretRefs: [{ key: "AUTH_SECRET" }] }
            : service,
      })),
    };

    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle: staleBundle,
      publicHost: "toks4-test.cognidao.org",
      computeApi: "legacy",
      leaseGeneration: 0,
    });

    // No throw — the desired state carries the FULL profile contract, deduped.
    expect(manifest.spec.workload.services[0]?.secretRefs).toEqual(
      REQUIRED_SECRET_REFS
    );
  });

  it("emits the legacy kind with no Crossplane-only policy fields", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4-test.cognidao.org",
      computeApi: "legacy",
      leaseGeneration: 0,
    });

    expect(manifest.kind).toBe("ComputeWorkload");
    expect(manifest.spec).not.toHaveProperty("migration");
    expect(manifest.spec).not.toHaveProperty("bootPolicy");
    expect(manifest.spec).not.toHaveProperty("dns");
    expect(manifest.spec).not.toHaveProperty("leaseGeneration");
  });

  it("emits the Crossplane composite with the policies the XRD made declarative", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 2,
      dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      runtime: { substrateHost: "cogni.vm.cognidao.org" },
    });

    expect(manifest.kind).toBe("XComputeWorkload");
    expect(manifest.apiVersion).toBe("compute.cogni.io/v1alpha1");
    // Empty-birth schema policy is stated, not inherited from the XRD default (bug.5116).
    // `RequireBeforeServing` since task.5135: migrating is a RELEASE step that gates readiness,
    // never a precondition of the paid Akash transaction. Writing this value is also what moves
    // the workload off the deprecated `RequireBeforeTransaction` lowering in the Composition,
    // so every rematerialize migrates one more node onto the decoupled path.
    expect(manifest.spec).toMatchObject({
      migration: { policy: "RequireBeforeServing" },
      bootPolicy: { onDeadline: "Hold" },
      leaseGeneration: 2,
      dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      runtime: { substrateHost: "cogni.vm.cognidao.org" },
    });
  });

  /**
   * THE REPLACEMENT PATH (story.5016). The actuator refuses to re-spend a settled idempotence
   * key (`akash_tx_create_refused_settled_key`), so a terminally closed lease makes its
   * (node, environment) unrecreatable until the generation moves — and the generation is
   * emitted EXPLICITLY, 0 included, so the desired state never leans on a default and a
   * catalog bump is a visible one-line diff on the deploy branch.
   */
  it("emits the catalog lease generation explicitly, even at zero", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });

    expect(manifest.spec).toHaveProperty("leaseGeneration", 0);
  });

  /**
   * ALIAS_IS_NEVER_WRITTEN (task.5122). The XRD still SERVES the deprecated `leaseEpoch`
   * field so the XComputeWorkloads already committed on deploy refs stay valid, but the
   * materializer must never write it again: canonical-only writes are what CONVERGE each
   * deploy ref off the alias, and a dual-write would pin the alias in every ref forever.
   */
  it("never writes the deprecated leaseEpoch alias", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "production",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle,
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 7,
    });

    expect(manifest.spec).not.toHaveProperty("leaseEpoch");
    expect(JSON.stringify(manifest)).not.toContain("leaseEpoch");
  });

  it("refuses a nonzero lease generation on the legacy authority, which reads none", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "legacy",
        leaseGeneration: 1,
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
        leaseGeneration: 0,
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
        leaseGeneration: 0,
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
      leaseGeneration: 0,
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
      leaseGeneration: 0,
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
    const { migration, bootPolicy, leaseGeneration, ...shared } =
      crossplane.spec as unknown as Record<string, unknown>;
    expect(shared).toEqual(legacy.spec);
    expect(migration).toBeDefined();
    expect(bootPolicy).toBeDefined();
    expect(leaseGeneration).toBe(0);
  });

  /**
   * PER_SERVICE_ENV_GATE (story.5043). A private sidecar may declare `envs:` to opt into a
   * subset of deployment environments; a service whose `envs` excludes THIS environment is
   * dropped from the workload entirely. This is what lets the poly node keep its paper-trader
   * sidecar in candidate-a/preview while production stays a 1-service lease it can ship in place.
   */
  describe("per-service envs gate (story.5043)", () => {
    const gatedBundle: ResolvedNodeArtifactBundle = {
      ...bundle,
      services: bundle.services.map((resolved) =>
        resolved.service.name === "worker"
          ? {
              ...resolved,
              service: {
                ...resolved.service,
                envs: ["candidate-a", "preview"] as const,
              },
            }
          : resolved
      ),
    };

    it.each([
      "candidate-a",
      "preview",
    ] as const)("keeps a gated sidecar in an environment it lists (%s)", (environment) => {
      const manifest = buildComputeWorkloadManifest({
        slug: "toks4",
        environment,
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle: gatedBundle,
        publicHost: `toks4-${environment}.cognidao.org`,
        computeApi: "crossplane",
        leaseGeneration: 0,
      });

      expect(
        manifest.spec.workload.services.map((service) => service.name)
      ).toEqual(["web", "worker"]);
      // Where the sidecar IS included, its artifact and the inbound binding are preserved.
      expect(manifest.spec.bundle.artifacts.map((a) => a.name)).toEqual([
        "web",
        "worker",
      ]);
      const web = manifest.spec.workload.services.find((s) => s.name === "web");
      expect(web?.bindings).toEqual({ WORKER_URL: "worker" });
    });

    it("drops a gated sidecar from an environment it does not list (production)", () => {
      const manifest = buildComputeWorkloadManifest({
        slug: "toks4",
        environment: "production",
        bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
        bundle: gatedBundle,
        publicHost: "toks4.cognidao.org",
        computeApi: "crossplane",
        leaseGeneration: 0,
      });

      // Only the public app remains — a 1-service lease, and the one public service survives.
      const names = manifest.spec.workload.services.map(
        (service) => service.name
      );
      expect(names).toEqual(["web"]);
      expect(
        manifest.spec.workload.services.filter(
          (service) => service.visibility === "public"
        )
      ).toHaveLength(1);

      // bug.5262 — the exclusion CASCADES: dropping `worker` also prunes the orphaned `worker`
      // artifact and the `web` service's now-dangling `WORKER_URL: worker` binding, so the
      // rendered XR satisfies the XRD's two cross-reference invariants (no artifact used by zero
      // services; no binding targeting a non-declared sibling) and Argo can sync it.
      expect(manifest.spec.bundle.artifacts.map((a) => a.name)).toEqual([
        "web",
      ]);
      const web = manifest.spec.workload.services.find((s) => s.name === "web");
      expect(web?.bindings).toEqual({});
    });

    it("keeps every service that declares no envs in every environment", () => {
      for (const environment of [
        "candidate-a",
        "preview",
        "production",
      ] as const) {
        const manifest = buildComputeWorkloadManifest({
          slug: "toks4",
          environment,
          bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
          bundle,
          publicHost:
            environment === "production"
              ? "toks4.cognidao.org"
              : `toks4-${environment}.cognidao.org`,
          computeApi: "crossplane",
          leaseGeneration: 0,
        });
        expect(
          manifest.spec.workload.services.map((service) => service.name)
        ).toEqual(["web", "worker"]);
      }
    });
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
        leaseGeneration: 0,
        dns: { provider: "cloudflare", zoneId: "0".repeat(32) },
      })
    ).toThrow(/carried only by the crossplane authority/);
  });
});

describe("bootPolicyForEnvironment", () => {
  /**
   * BOOT_SLO_OR_CLOSE. `onDeadline` fires only when `status.serving` never became true within
   * `bootDeadlineSeconds` of the XR's CREATION — a lane that never served once. Nothing ran,
   * so there is nothing to inspect, so no non-production lane pays rent for it.
   *
   * This is the whole reason story.5025's transient candidate cannot leak spend, and since
   * task.5132 it is the only thing stopping a never-booting PAID preview lease from billing
   * until a human notices: `story.5039`'s deactivate half is unbuilt and there is no
   * `closeLease` path in this repo (`bug.5189` is what an orphaned lease costs).
   */
  it("closes a never-served lease in every non-production environment", () => {
    expect(bootPolicyForEnvironment("candidate-a")).toEqual({
      onDeadline: "Close",
    });
    expect(bootPolicyForEnvironment("preview")).toEqual({
      onDeadline: "Close",
    });
  });

  /**
   * Production is the one lane that holds. A promote that fails to boot is a real incident,
   * the PREVIOUS lease is still serving production, and the dead one is the evidence.
   */
  it("holds a never-served production lease as incident evidence", () => {
    expect(bootPolicyForEnvironment("production")).toEqual({
      onDeadline: "Hold",
    });
  });

  /**
   * ONE PREDICATE. `bootPolicy` and `actuatorNamespace` both key on "is this production?", so a
   * lane added to `DeploymentEnvironment` later cannot arrive holding only half the policy —
   * which is exactly how preview became a paid lane that would never close itself.
   */
  it("gives every environment but production the disposable policy", () => {
    for (const environment of deploymentEnvironmentSchema.options) {
      expect(bootPolicyForEnvironment(environment).onDeadline).toBe(
        environment === "production" ? "Hold" : "Close"
      );
    }
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

describe("actuator namespace (task.5132)", () => {
  const base = {
    slug: "toks4",
    bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
    bundle,
    leaseGeneration: 0,
  } as const;

  it("points a non-production lane at the production writer", () => {
    // The production cluster reconciles every akash node's non-prod lane, so the XR lands
    // in `cogni-candidate-a` THERE — a namespace that runs no actuator. Without this the
    // Composition defaults the writer lookup to the XR's own namespace and fails closed.
    for (const environment of ["candidate-a", "preview"] as const) {
      const manifest = buildComputeWorkloadManifest({
        ...base,
        environment,
        publicHost: `toks4-${environment}.cognidao.org`,
        computeApi: "crossplane",
      });
      expect(
        (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace,
        environment
      ).toBe("cogni-production");
    }
  });

  it("omits it for production — the default is already correct there", () => {
    const manifest = buildComputeWorkloadManifest({
      ...base,
      environment: "production",
      publicHost: "toks4.cognidao.org",
      computeApi: "crossplane",
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBeUndefined();
  });

  it("never emits it on the legacy authority, which has no such field", () => {
    const manifest = buildComputeWorkloadManifest({
      ...base,
      environment: "candidate-a",
      publicHost: "toks4-test.cognidao.org",
      computeApi: "legacy",
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBeUndefined();
  });

  it("leaves the idempotence key derived from the XR's OWN namespace", () => {
    // The whole point of the split: the key stays per-lane (so a node's pre-prod lease can
    // never collide with its production one) while the WRITER is shared.
    const manifest = buildComputeWorkloadManifest({
      ...base,
      environment: "candidate-a",
      publicHost: "toks4-test.cognidao.org",
      computeApi: "crossplane",
    });
    expect(manifest.metadata.namespace).toBe("cogni-candidate-a");
  });
});

/**
 * ACTUATOR NAMESPACE IS OWNER-ROUTED (bug.5263). WHO PAYS is a function of the node's OWNER org,
 * not the environment (akash-actuator-wallet-cutover NS3/NS4): every REAL cogni-dao node bills
 * the production Console account in every environment, while the candidate-a TEST account pays
 * ONLY for cogni-test-org throwaway nodes that self-test the platform. The materializer resolves
 * this via `writerFor(env, owner)`, deriving the owner from the bundle's own source repository.
 *
 * The load-bearing safety property proven here: this change reroutes ONLY cogni-test-org nodes to
 * the candidate-a test wallet. NO cogni-dao (real, paid) node's rendering changes.
 */
describe("actuator namespace owner routing (bug.5263)", () => {
  const bundleForOwner = (repository: string): ResolvedNodeArtifactBundle => ({
    ...bundle,
    source: { repository, sha: SHA },
  });

  // (a) THE FIX. A cogni-test-org node on candidate-a bills the candidate-a TEST writer, whose
  // actuator + `akash-tx-actuator-auth` secret live in `cogni-candidate-a`. Before this it
  // resolved to `cogni-production` and failed closed with a missing secret.
  it("routes a cogni-test-org candidate-a node to the candidate-a test writer", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "spawny-boi",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-test-org/spawny-boi@sha256:${BUNDLE_DIGEST}`,
      bundle: bundleForOwner("cogni-test-org/spawny-boi"),
      publicHost: "spawny-boi-test.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBe("cogni-candidate-a");
  });

  it("routes a cogni-test-org preview node to the candidate-a test writer (NS4)", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "spawny-boi",
      environment: "preview",
      bundleRef: `ghcr.io/cogni-test-org/spawny-boi@sha256:${BUNDLE_DIGEST}`,
      bundle: bundleForOwner("cogni-test-org/spawny-boi"),
      publicHost: "spawny-boi-preview.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBe("cogni-candidate-a");
  });

  // (b) MUST NOT REROUTE REAL NODES. A cogni-dao node on candidate-a still bills PRODUCTION.
  it("keeps a cogni-dao candidate-a node on the production writer (unchanged)", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle: bundleForOwner("cogni-dao/toks4"),
      publicHost: "toks4-test.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBe("cogni-production");
  });

  // (c) A cogni-dao node on preview still bills PRODUCTION (unchanged).
  it("keeps a cogni-dao preview node on the production writer (unchanged)", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "preview",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle: bundleForOwner("cogni-dao/toks4"),
      publicHost: "toks4-preview.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBe("cogni-production");
  });

  // (d) Production OMITS the field for EVERY owner — the XR's own ns is already cogni-production.
  it("omits actuatorNamespace in production for every owner (unchanged)", () => {
    for (const repository of ["cogni-dao/toks4", "cogni-test-org/spawny-boi"]) {
      const manifest = buildComputeWorkloadManifest({
        slug: "node",
        environment: "production",
        bundleRef: `ghcr.io/${repository}@sha256:${BUNDLE_DIGEST}`,
        bundle: bundleForOwner(repository),
        publicHost: "node.cognidao.org",
        computeApi: "crossplane",
        leaseGeneration: 0,
      });
      expect(
        (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace,
        repository
      ).toBeUndefined();
    }
  });

  // FAIL CLOSED. An owner with no single writer must be refused, never defaulted to a wallet —
  // silently defaulting would bill the wrong Console account (NO_SILENT_DEFAULT).
  it("fails closed on an unknown owner rather than defaulting a wallet", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        slug: "mystery",
        environment: "candidate-a",
        bundleRef: `ghcr.io/some-rando-org/mystery@sha256:${BUNDLE_DIGEST}`,
        bundle: bundleForOwner("some-rando-org/mystery"),
        publicHost: "mystery-test.cognidao.org",
        computeApi: "crossplane",
        leaseGeneration: 0,
      })
    ).toThrow(/refusing to default a wallet/);
  });

  // (e) BYTE-IDENTICAL. The FULL cogni-dao candidate-a crossplane manifest is exactly what it
  // was before owner routing existed (actuatorNamespace: cogni-production). This is the real-money
  // guarantee that no paid node's desired state shifted.
  it("renders a cogni-dao candidate-a manifest byte-identical to the pre-fix output", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: "toks4",
      environment: "candidate-a",
      bundleRef: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
      bundle: bundleForOwner("cogni-dao/toks4"),
      publicHost: "toks4-test.cognidao.org",
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(manifest).toEqual({
      apiVersion: "compute.cogni.io/v1alpha1",
      kind: "XComputeWorkload",
      metadata: {
        name: NODE_ID,
        namespace: "cogni-candidate-a",
        labels: {
          "cogni.io/node-id": NODE_ID,
          "cogni.io/environment": "candidate-a",
          "cogni.io/node": "toks4",
        },
      },
      spec: {
        nodeId: NODE_ID,
        environment: "candidate-a",
        bundle: {
          ref: `ghcr.io/cogni-dao/toks4@sha256:${BUNDLE_DIGEST}`,
          source: { repository: "cogni-dao/toks4", sha: SHA },
          artifacts: bundle.artifacts,
        },
        workload: {
          name: "toks4",
          publicHost: "toks4-test.cognidao.org",
          services: [
            {
              name: "web",
              artifact: "web",
              runtimeProfile: "cogni-node-app-v1",
              secretRefs: REQUIRED_SECRET_REFS,
              port: 3200,
              visibility: "public",
              bindings: { WORKER_URL: "worker" },
              bindHost: "0.0.0.0",
              cpuUnits: 0.5,
              memoryMi: 1024,
              storageMi: 2048,
            },
            {
              name: "worker",
              artifact: "worker",
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
        migration: { policy: "RequireBeforeServing" },
        bootPolicy: { onDeadline: "Close" },
        leaseGeneration: 0,
        actuatorNamespace: "cogni-production",
      },
    });
  });
});
