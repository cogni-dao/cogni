// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/scaffolded-node-deployment`
 * Purpose: Prove the fleet contract end to end — a node minted by the scaffold is Akash-capable
 *   with zero hand-editing, and a node that omits `deployment:` fails EARLY with a message that
 *   names exactly what to add instead of dying terminally at reconcile.
 * Scope: Pure composition of the mint generator, repo-spec parsing, bundle resolution, and the
 *   two deploy gates. No provider, cluster, git, or secret I/O.
 * Invariants: BORN_DEPLOYABLE, DECLARED_NOT_DEFAULTED, NO_NODE_SPECIFIC_CALLOUTS.
 * Side-effects: none
 * Links: task.5079, story.5016, src/shared/node-app-scaffold/gens/repo-spec.ts
 * @public
 */

import {
  buildNodeArtifactBundle,
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  extractNodeServices,
  parseRepoSpec,
  resolveNodeArtifactBundle,
  resolveRuntimeProfileSecretRefs,
} from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

import { renderRepoSpec } from "@/shared/node-app-scaffold/gens/repo-spec";

import { buildComputeWorkloadManifest } from "./compute-workload-manifest";
import { buildComputeSecretResources } from "./compute-workload-secret-manifests";
import { assertDeclaredNodeDeployment } from "./node-services-workload-spec";

const SLUG = "my-node";
// A spawned throwaway node is owned by cogni-test-org (the platform's own self-test org), which
// is the owner axis `writerFor` routes to the candidate-a test wallet (akash-actuator-wallet-cutover
// NS4). The prior placeholder `cogni-dao-test` was neither a real GitHub org nor a recognized
// actuator-writer owner, so it made this spawn-path fixture unfaithful to production (bug.5263).
const OWNER = "cogni-test-org";
const SOURCE_SHA = "a".repeat(40);
const IMAGE_DIGEST = "b".repeat(64);
const BUNDLE_DIGEST = "c".repeat(64);
const NODE_ID = "11111111-2222-4333-8444-555555555555";

const scaffoldedYaml = renderRepoSpec({
  slug: SLUG,
  repoOwner: OWNER,
  nodeId: NODE_ID,
  chainId: 8453,
  daoContract: "0x1111111111111111111111111111111111111111",
  pluginContract: "0x2222222222222222222222222222222222222222",
  signalContract: "0x3333333333333333333333333333333333333333",
  tokenContract: "0x4444444444444444444444444444444444444444",
});

const scaffolded = parseRepoSpec(scaffoldedYaml);

function resolveScaffoldedBundle() {
  const services = extractNodeServices(scaffolded);
  const bundle = buildNodeArtifactBundle({
    spec: scaffolded,
    sourceSha: SOURCE_SHA,
    repository: `${OWNER}/${SLUG}`,
    artifacts: [
      ...new Set(services.map((service) => service.artifact.name)),
    ].map((artifact) => ({
      artifact,
      sourceSha: SOURCE_SHA,
      image: `ghcr.io/${OWNER}/${SLUG}-${artifact}@sha256:${IMAGE_DIGEST}`,
    })),
  });
  return resolveNodeArtifactBundle(scaffolded, bundle, {
    sourceSha: SOURCE_SHA,
    repository: `${OWNER}/${SLUG}`,
  });
}

describe("scaffolded node is born Akash-capable", () => {
  it("mints a repo-spec that parses and declares its own deployment", () => {
    expect(scaffolded.deployment).toBeDefined();
    expect(scaffolded.deployment?.services).toHaveLength(1);
  });

  it("satisfies the reconciler's required runtime-env contract", () => {
    const [app] = extractNodeServices(scaffolded);
    expect(app?.runtimeProfile).toBe("cogni-node-app-v1");
    expect(app?.visibility).toBe("public");
    // The minted spec lists NO profile refs — the profile owns that contract, not the node.
    expect(app?.secretRefs).toEqual([]);
    // Resolved at build time, the app receives the complete profile secret contract.
    expect(
      resolveRuntimeProfileSecretRefs({
        runtimeProfile: app?.runtimeProfile,
        secretRefs: app?.secretRefs ?? [],
      }).map((ref) => ref.key)
    ).toEqual([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS]);
  });

  it("declares complete resources for every service", () => {
    for (const service of extractNodeServices(scaffolded)) {
      expect(service.resources.cpuUnits).toBeGreaterThan(0);
      expect(service.resources.memoryMi).toBeGreaterThan(0);
      expect(service.resources.storageMi).toBeGreaterThan(0);
    }
  });

  it("materializes desired state without hand-editing the minted spec", () => {
    const manifest = buildComputeWorkloadManifest({
      slug: SLUG,
      environment: "candidate-a",
      bundleRef: `ghcr.io/${OWNER}/${SLUG}@sha256:${BUNDLE_DIGEST}`,
      bundle: resolveScaffoldedBundle(),
      publicHost: `${SLUG}.example.org`,
      computeApi: "crossplane",
      leaseGeneration: 0,
    });
    expect(
      manifest.spec.workload.services[0]?.secretRefs?.map((ref) => ref.key)
    ).toEqual([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS]);
    // bug.5263: a cogni-test-org spawn on candidate-a must route to the candidate-a TEST wallet
    // (`cogni-candidate-a`), where the actuator + its `akash-tx-actuator-auth` secret actually
    // live — NOT `cogni-production`, which has no secret for this org and fails the lease create.
    expect(
      (manifest.spec as unknown as Record<string, unknown>).actuatorNamespace
    ).toBe("cogni-candidate-a");
  });

  it("projects every profile-supplied secret ref into an off-cluster workload secret", () => {
    // Mirror the production materialize path: resolve profile-implied refs before projecting.
    const resources = buildComputeSecretResources({
      slug: SLUG,
      environment: "candidate-a",
      secretRefs: resolveScaffoldedBundle().services.flatMap((service) =>
        resolveRuntimeProfileSecretRefs({
          ...(service.service.runtimeProfile
            ? { runtimeProfile: service.service.runtimeProfile }
            : {}),
          secretRefs: service.service.secretRefs,
        })
      ),
    });
    // The scaffolded node declares no refs, yet the profile supplies a full contract to project,
    // and no key is rejected by the off-cluster-workload provenance denylist.
    expect(resources).not.toHaveLength(0);
  });
});

describe("a node missing the deployment block fails early, not terminally", () => {
  const undeclared = buildTestRepoSpec();

  it("rejects the legacy no-secrets fallback before any provider work", () => {
    expect(() =>
      assertDeclaredNodeDeployment({
        spec: undeclared,
        slug: SLUG,
        sourceSha: SOURCE_SHA,
      })
    ).toThrow(/off-cluster compute requires a `deployment:` block/);
  });

  it("names the file, the source revision, and the exact block to paste", () => {
    let message = "";
    try {
      assertDeclaredNodeDeployment({
        spec: undeclared,
        slug: SLUG,
        sourceSha: SOURCE_SHA,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(".cogni/repo-spec.yaml");
    expect(message).toContain(SOURCE_SHA);
    expect(message).toContain("deployment:");
    expect(message).toContain("runtime_profile: cogni-node-app-v1");
    // The pasted block no longer lists the profile's secret_refs — the profile supplies them.
    expect(message).not.toContain("- key:");
  });

  it("keeps the k3s lane on the unchanged fallback", () => {
    // Omission must still resolve — k3s nodes get their env from their own
    // ExternalSecret overlay, so an empty secret_refs list is correct there.
    expect(extractNodeServices(undeclared)[0]?.secretRefs).toEqual([]);
    expect(extractNodeServices(undeclared)[0]?.runtimeProfile).toBe(
      "cogni-node-app-v1"
    );
  });
});
