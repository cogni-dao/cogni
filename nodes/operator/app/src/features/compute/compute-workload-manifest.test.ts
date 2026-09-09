// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import { buildComputeWorkloadManifest } from "./compute-workload-manifest";
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
      })
    ).toThrow(/cogni-node-app-v1 is missing secret_refs/);
  });
});
