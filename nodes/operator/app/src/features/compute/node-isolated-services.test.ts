// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { buildComputeWorkloadManifest } from "./compute-workload-manifest";
import { requiredLeaseGeneration } from "./lease-reactivation";
import {
  receiptsForWorkload,
  resolveNodeIsolatedServices,
} from "./node-isolated-services";
import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "./node-services-workload-spec";

const SHA = "a".repeat(40);
const NODE_ID = "921b1d1d-4ded-4a6d-b3f1-f7d6affa406a";
const BUNDLE_REF = `ghcr.io/cogni-dao/red@sha256:${"c".repeat(64)}`;
const APP_IMAGE = `ghcr.io/cogni-dao/red@sha256:${"b".repeat(64)}`;
const SANDBOX_IMAGE = `ghcr.io/cogni-dao/red-sandbox@sha256:${"d".repeat(64)}`;

function bundleWith(
  appBindings: Record<string, string> = {}
): ResolvedNodeArtifactBundle {
  return {
    nodeId: NODE_ID,
    source: { repository: "cogni-dao/red", sha: SHA },
    artifacts: [
      { name: "app", image: APP_IMAGE },
      { name: "sandbox", image: SANDBOX_IMAGE },
    ],
    services: [
      {
        artifact: "app",
        image: APP_IMAGE,
        service: {
          name: "app",
          artifact: { name: "app", context: ".", dockerfile: "Dockerfile" },
          port: 3200,
          visibility: "public",
          runtimeProfile: "cogni-node-app-v1",
          bindings: appBindings,
          secretRefs: COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map((key) => ({
            key,
          })),
          bindHost: "0.0.0.0",
          internalUrl: "http://app:3200",
          resources: { cpuUnits: 2, memoryMi: 2048, storageMi: 4096 },
        },
      },
      {
        artifact: "sandbox",
        image: SANDBOX_IMAGE,
        service: {
          name: "sandbox",
          artifact: {
            name: "sandbox",
            context: "services/sandbox",
            dockerfile: "services/sandbox/Dockerfile",
          },
          port: 8080,
          visibility: "private",
          bindings: {},
          secretRefs: [{ key: "SANDBOX_EXECD_TOKEN" }],
          bindHost: "0.0.0.0",
          internalUrl: "http://sandbox:8080",
          resources: { cpuUnits: 1, memoryMi: 1024, storageMi: 5120 },
        },
      },
    ],
  };
}

const base = {
  slug: "red",
  environment: "production" as const,
  bundleRef: BUNDLE_REF,
  computeApi: "crossplane" as const,
  leaseGeneration: 0,
};

describe("isolated-service workloads (story.5093)", () => {
  it("removes an isolated service from the primary workload and keeps its identity", () => {
    const primary = buildComputeWorkloadManifest({
      ...base,
      bundle: bundleWith(),
      publicHost: "red.cognidao.org",
      isolatedServices: ["sandbox"],
    });
    expect(primary.metadata.name).toBe(NODE_ID);
    expect(primary.spec).not.toHaveProperty("instance");
    expect(primary.spec.workload.services.map((s) => s.name)).toEqual(["app"]);
    expect(primary.spec.bundle.artifacts.map((a) => a.name)).toEqual(["app"]);
  });

  it("renders the instance lease as its own named, public, node-owned workload", () => {
    const instance = buildComputeWorkloadManifest({
      ...base,
      bundle: bundleWith(),
      publicHost: "red-sandbox.cognidao.org",
      leaseGeneration: 4,
      instance: "sandbox",
    });
    expect(instance.metadata.name).toBe(`${NODE_ID}-sandbox`);
    expect(instance.metadata.labels).toMatchObject({
      "cogni.io/node-id": NODE_ID,
      "cogni.io/node": "red",
      "cogni.io/instance": "sandbox",
    });
    expect(instance.spec).toMatchObject({
      nodeId: NODE_ID,
      instance: "sandbox",
      leaseGeneration: 4,
      workload: { name: "red", publicHost: "red-sandbox.cognidao.org" },
    });
    expect(instance.spec.workload.services).toEqual([
      expect.objectContaining({
        name: "sandbox",
        visibility: "public",
        secretRefs: [{ key: "SANDBOX_EXECD_TOKEN" }],
      }),
    ]);
    expect(instance.spec.workload.services[0]).not.toHaveProperty(
      "runtimeProfile"
    );
    expect(instance.spec.bundle.artifacts.map((a) => a.name)).toEqual([
      "sandbox",
    ]);
  });

  it("refuses an app binding that would cross into an isolated lease", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        ...base,
        bundle: bundleWith({ SANDBOX_URL: "sandbox" }),
        publicHost: "red.cognidao.org",
        isolatedServices: ["sandbox"],
      })
    ).toThrow(/isolated service sandbox/);
  });

  it("refuses isolation on the legacy authority and an undeclared instance", () => {
    expect(() =>
      buildComputeWorkloadManifest({
        ...base,
        computeApi: "legacy",
        bundle: bundleWith(),
        publicHost: "red.cognidao.org",
        isolatedServices: ["sandbox"],
      })
    ).toThrow(/crossplane/);
    expect(() =>
      buildComputeWorkloadManifest({
        ...base,
        bundle: bundleWith(),
        publicHost: "red-missing.cognidao.org",
        instance: "missing",
      })
    ).toThrow(/not declared/);
    expect(() =>
      buildComputeWorkloadManifest({
        ...base,
        bundle: bundleWith(),
        publicHost: "red-app.cognidao.org",
        instance: "app",
      })
    ).toThrow(/runtime_profile/);
  });

  it("resolves catalog cells per environment with zero as the default generation", () => {
    const catalog = {
      isolated_services: { sandbox: { lease_generation: { production: 2 } } },
    };
    expect(
      resolveNodeIsolatedServices({ catalog, environment: "production" })
    ).toEqual([{ service: "sandbox", leaseGeneration: 2 }]);
    expect(
      resolveNodeIsolatedServices({ catalog, environment: "candidate-a" })
    ).toEqual([{ service: "sandbox", leaseGeneration: 0 }]);
    expect(
      resolveNodeIsolatedServices({ catalog: {}, environment: "production" })
    ).toEqual([]);
    expect(() =>
      resolveNodeIsolatedServices({
        catalog: { isolated_services: { Bad_Name: {} } },
        environment: "production",
      })
    ).toThrow(/isolated_services/);
  });

  it("keeps an instance lease's receipts out of the primary workload's generation evidence", () => {
    const receipts = [
      { cogniKey: `xcw:cogni-production:${NODE_ID}:0`, state: "allocated" },
      {
        cogniKey: `xcw:cogni-production:${NODE_ID}-sandbox:7`,
        state: "released",
      },
    ] as unknown as Parameters<typeof requiredLeaseGeneration>[0]["receipts"];
    const primary = receiptsForWorkload(receipts, {
      environment: "production",
      name: NODE_ID,
    });
    expect(primary.map((r) => r.cogniKey)).toEqual([
      `xcw:cogni-production:${NODE_ID}:0`,
    ]);
    expect(
      receiptsForWorkload(receipts, {
        environment: "production",
        name: `${NODE_ID}-sandbox`,
      }).map((r) => r.cogniKey)
    ).toEqual([`xcw:cogni-production:${NODE_ID}-sandbox:7`]);
    // Unscoped, the instance's spent generation 7 would force the app to generation 8.
    expect(requiredLeaseGeneration({ catalogGeneration: 0, receipts })).toBe(8);
    expect(
      requiredLeaseGeneration({ catalogGeneration: 0, receipts: primary })
    ).toBe(0);
  });
});
