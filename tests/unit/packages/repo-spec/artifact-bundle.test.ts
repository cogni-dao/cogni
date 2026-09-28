// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/artifact-bundle`
 * Purpose: Prove exact-set, one-source-SHA, digest-pinned node artifact bundles.
 * Scope: Pure repo-spec bundle assembly and resolution. Does not access files, registries, or deploy state.
 * Invariants: ATOMIC_OR_NOTHING, DIGEST_PINNED, ONE_SOURCE_SHA.
 * Side-effects: none
 * Links: packages/repo-spec/src/artifact-bundle.ts, task.5065
 * @public
 */

import type {
  DeploymentEnvName,
  ResolvedNodeArtifactBundle,
} from "@cogni/repo-spec";
import {
  buildNodeArtifactBundle,
  resolveNodeArtifactBundle,
  resolveNodeArtifactBundleForEnvironment,
} from "@cogni/repo-spec";
import { buildTestRepoSpec, TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const SOURCE_SHA = "a".repeat(40);
const APP_IMAGE = `ghcr.io/example/node@sha256:${"1".repeat(64)}`;
const WORKER_IMAGE = `ghcr.io/example/node-worker@sha256:${"2".repeat(64)}`;

function multiServiceSpec() {
  return buildTestRepoSpec({
    deployment: {
      services: [
        {
          name: "app",
          artifact: { name: "app" },
          port: 3200,
          visibility: "public",
          resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
        },
        {
          name: "worker",
          artifact: {
            name: "worker",
            dockerfile: "services/worker/Dockerfile",
          },
          port: 9100,
          visibility: "private",
          resources: { cpu_units: 0.5, memory_mi: 1024, storage_mi: 2048 },
        },
      ],
    },
  });
}

function completeBundle() {
  return buildNodeArtifactBundle({
    spec: multiServiceSpec(),
    sourceSha: SOURCE_SHA,
    repository: "example/node",
    artifacts: [
      { artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE },
      { artifact: "worker", sourceSha: SOURCE_SHA, image: WORKER_IMAGE },
    ],
  });
}

describe("node artifact bundle", () => {
  it("emits one source identity, artifact digest authority, and service refs", () => {
    const bundle = completeBundle();

    expect(bundle).toEqual({
      schema_version: 1,
      node_id: TEST_NODE_IDS.default,
      source: { repository: "example/node", sha: SOURCE_SHA },
      artifacts: [
        { name: "app", image: APP_IMAGE },
        { name: "worker", image: WORKER_IMAGE },
      ],
      services: [
        { name: "app", artifact: "app" },
        { name: "worker", artifact: "worker" },
      ],
    });

    const resolved = resolveNodeArtifactBundle(multiServiceSpec(), bundle, {
      sourceSha: SOURCE_SHA,
      repository: "example/node",
    });
    expect(resolved).toMatchObject({
      nodeId: TEST_NODE_IDS.default,
      source: { repository: "example/node", sha: SOURCE_SHA },
      artifacts: bundle.artifacts,
    });
    expect(
      resolved.services.map(({ service, artifact, image }) => [
        service.name,
        artifact,
        image,
      ])
    ).toEqual([
      ["app", "app", APP_IMAGE],
      ["worker", "worker", WORKER_IMAGE],
    ]);
    expect(resolved.services[0]?.service.secretRefs).toEqual([]);
  });

  it("builds one artifact once and maps it to multiple services", () => {
    const spec = buildTestRepoSpec({
      deployment: {
        services: [
          {
            name: "app",
            artifact: { name: "app" },
            port: 3200,
            visibility: "public",
            resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
          },
          {
            name: "worker",
            artifact: { name: "app" },
            port: 9100,
            visibility: "private",
            resources: { cpu_units: 0.5, memory_mi: 1024, storage_mi: 2048 },
          },
        ],
      },
    });
    const bundle = buildNodeArtifactBundle({
      spec,
      sourceSha: SOURCE_SHA,
      repository: "example/node",
      artifacts: [{ artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE }],
    });

    expect(bundle.artifacts).toEqual([{ name: "app", image: APP_IMAGE }]);
    expect(bundle.services).toEqual([
      { name: "app", artifact: "app" },
      { name: "worker", artifact: "app" },
    ]);
  });

  it.each([
    {
      name: "stale source SHA",
      expected: { sourceSha: "b".repeat(40), repository: "example/node" },
      message: /Source SHA mismatch/,
    },
    {
      name: "wrong repository",
      expected: { sourceSha: SOURCE_SHA, repository: "example/other" },
      message: /Repository mismatch/,
    },
  ])("rejects a complete bundle with $name", ({ expected, message }) => {
    expect(() =>
      resolveNodeArtifactBundle(multiServiceSpec(), completeBundle(), expected)
    ).toThrow(message);
  });

  it("supports the omission default as one app artifact", () => {
    const spec = buildTestRepoSpec();
    const bundle = buildNodeArtifactBundle({
      spec,
      sourceSha: SOURCE_SHA,
      repository: "example/node",
      artifacts: [{ artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE }],
    });
    expect(bundle).toMatchObject({
      source: { repository: "example/node", sha: SOURCE_SHA },
      artifacts: [{ name: "app", image: APP_IMAGE }],
      services: [{ name: "app", artifact: "app" }],
    });
  });

  it("canonicalizes GitHub repository identity case", () => {
    const bundle = buildNodeArtifactBundle({
      spec: multiServiceSpec(),
      sourceSha: SOURCE_SHA,
      repository: "Example/Node",
      artifacts: [
        { artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SOURCE_SHA, image: WORKER_IMAGE },
      ],
    });
    expect(bundle.source.repository).toBe("example/node");
    expect(() =>
      resolveNodeArtifactBundle(multiServiceSpec(), bundle, {
        sourceSha: SOURCE_SHA,
        repository: "EXAMPLE/NODE",
      })
    ).not.toThrow();
  });

  it.each([
    {
      name: "missing matrix leg",
      artifacts: [{ artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE }],
      message: /Missing artifact for service worker/,
    },
    {
      name: "undeclared artifact",
      artifacts: [
        { artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SOURCE_SHA, image: WORKER_IMAGE },
        { artifact: "surprise", sourceSha: SOURCE_SHA, image: APP_IMAGE },
      ],
      message: /Undeclared built artifact/,
    },
    {
      name: "mixed source SHA",
      artifacts: [
        { artifact: "app", sourceSha: SOURCE_SHA, image: APP_IMAGE },
        {
          artifact: "worker",
          sourceSha: "b".repeat(40),
          image: WORKER_IMAGE,
        },
      ],
      message: /Source SHA mismatch/,
    },
    {
      name: "mutable image tag",
      artifacts: [
        {
          artifact: "app",
          sourceSha: SOURCE_SHA,
          image: "ghcr.io/example/node:latest",
        },
        { artifact: "worker", sourceSha: SOURCE_SHA, image: WORKER_IMAGE },
      ],
      message: /Invalid bundle/,
    },
  ])("fails atomically on $name", ({ artifacts, message }) => {
    expect(() =>
      buildNodeArtifactBundle({
        spec: multiServiceSpec(),
        sourceSha: SOURCE_SHA,
        repository: "example/node",
        artifacts,
      })
    ).toThrow(message);
  });

  it("rejects dangling service artifact refs before resolution", () => {
    const bundle = completeBundle();
    expect(() =>
      resolveNodeArtifactBundle(
        multiServiceSpec(),
        {
          ...bundle,
          services: [
            bundle.services[0],
            { name: "worker", artifact: "missing" },
          ],
        },
        { sourceSha: SOURCE_SHA, repository: "example/node" }
      )
    ).toThrow(/Service references missing artifact/);
  });
});

/**
 * bug.5262 — the per-service `envs` gate (story.5043) must CASCADE. Dropping a gated-out service
 * without also pruning (a) the artifact only it referenced and (b) any surviving service's binding
 * that targeted it produced an XComputeWorkload XR that violated the XRD's two cross-reference
 * invariants, and Argo's server-side-diff refused to sync it — freezing poly's production deploy.
 * These assertions mirror the XRD's exact CEL semantics
 * (infra/crossplane/xcomputeworkload/xrd.yaml).
 */
describe("resolveNodeArtifactBundleForEnvironment (bug.5262 cascade)", () => {
  /** XRD: "every bundle artifact must be used by at least one service". */
  function everyArtifactUsed(bundle: ResolvedNodeArtifactBundle): boolean {
    const referenced = new Set(bundle.services.map(({ artifact }) => artifact));
    return bundle.artifacts.every((artifact) => referenced.has(artifact.name));
  }
  /** XRD: "every service must reference a declared bundle artifact". */
  function everyServiceHasArtifact(
    bundle: ResolvedNodeArtifactBundle
  ): boolean {
    const declared = new Set(bundle.artifacts.map((artifact) => artifact.name));
    return bundle.services.every(({ artifact }) => declared.has(artifact));
  }
  /** XRD: "every binding must target a different declared sibling service". */
  function everyBindingTargetsSibling(
    bundle: ResolvedNodeArtifactBundle
  ): boolean {
    const declared = new Set(
      bundle.services.map(({ service }) => service.name)
    );
    return bundle.services.every(({ service }) =>
      Object.values(service.bindings).every(
        (target) => target !== service.name && declared.has(target)
      )
    );
  }

  const APP_IMG = `ghcr.io/example/poly-app@sha256:${"1".repeat(64)}`;
  const SIDECAR_IMG = `ghcr.io/example/poly-paper-trader@sha256:${"2".repeat(64)}`;

  function serviceConfig(
    overrides: Partial<
      ResolvedNodeArtifactBundle["services"][number]["service"]
    > & { name: string; port: number }
  ): ResolvedNodeArtifactBundle["services"][number]["service"] {
    return {
      artifact: {
        name: overrides.name,
        context: ".",
        dockerfile: "Dockerfile",
      },
      port: overrides.port,
      visibility: "private",
      bindings: {},
      secretRefs: [],
      bindHost: "0.0.0.0",
      internalUrl: `http://${overrides.name}:${overrides.port}`,
      resources: { cpuUnits: 0.5, memoryMi: 512, storageMi: 1024 },
      ...overrides,
    };
  }

  /** app (public) binds a paper-trader sidecar gated to candidate-a/preview only. */
  function polyBundle(): ResolvedNodeArtifactBundle {
    return {
      nodeId: TEST_NODE_IDS.default,
      source: { repository: "example/poly", sha: SOURCE_SHA },
      artifacts: [
        { name: "app", image: APP_IMG },
        { name: "paper-trader", image: SIDECAR_IMG },
      ],
      services: [
        {
          artifact: "app",
          image: APP_IMG,
          service: serviceConfig({
            name: "app",
            port: 3200,
            visibility: "public",
            runtimeProfile: "cogni-node-app-v1",
            bindings: { PAPER_SIDECAR_URL: "paper-trader" },
          }),
        },
        {
          artifact: "paper-trader",
          image: SIDECAR_IMG,
          service: serviceConfig({
            name: "paper-trader",
            port: 9200,
            envs: ["candidate-a", "preview"],
          }),
        },
      ],
    };
  }

  it("drops a gated-out sidecar's artifact AND the inbound binding (production)", () => {
    const resolved = resolveNodeArtifactBundleForEnvironment(
      polyBundle(),
      "production"
    );

    // The sidecar service is gone — a 1-service (public) lease.
    expect(resolved.services.map(({ service }) => service.name)).toEqual([
      "app",
    ]);
    // (a) its orphaned artifact is pruned...
    expect(resolved.artifacts.map((artifact) => artifact.name)).toEqual([
      "app",
    ]);
    // (b) ...and the app's now-dangling PAPER_SIDECAR_URL binding is pruned.
    expect(resolved.services[0]?.service.bindings).toEqual({});

    // Both XRD invariants now hold on the resolved prod bundle.
    expect(everyArtifactUsed(resolved)).toBe(true);
    expect(everyServiceHasArtifact(resolved)).toBe(true);
    expect(everyBindingTargetsSibling(resolved)).toBe(true);
  });

  it.each([
    "candidate-a",
    "preview",
  ] as const)("keeps the sidecar artifact and binding where it is included (%s)", (environment: DeploymentEnvName) => {
    const resolved = resolveNodeArtifactBundleForEnvironment(
      polyBundle(),
      environment
    );

    expect(resolved.services.map(({ service }) => service.name)).toEqual([
      "app",
      "paper-trader",
    ]);
    expect(resolved.artifacts.map((artifact) => artifact.name)).toEqual([
      "app",
      "paper-trader",
    ]);
    expect(resolved.services[0]?.service.bindings).toEqual({
      PAPER_SIDECAR_URL: "paper-trader",
    });
    expect(everyArtifactUsed(resolved)).toBe(true);
    expect(everyBindingTargetsSibling(resolved)).toBe(true);
  });

  it("does not over-drop a shared artifact still used by an included service", () => {
    // Two private workers SHARE one artifact ("worker"); only worker-b is gated out of production.
    const WORKER_IMG = `ghcr.io/example/poly-worker@sha256:${"3".repeat(64)}`;
    const shared: ResolvedNodeArtifactBundle = {
      nodeId: TEST_NODE_IDS.default,
      source: { repository: "example/poly", sha: SOURCE_SHA },
      artifacts: [
        { name: "app", image: APP_IMG },
        { name: "worker", image: WORKER_IMG },
      ],
      services: [
        {
          artifact: "app",
          image: APP_IMG,
          service: serviceConfig({
            name: "app",
            port: 3200,
            visibility: "public",
          }),
        },
        {
          artifact: "worker",
          image: WORKER_IMG,
          service: serviceConfig({ name: "worker-a", port: 9100 }),
        },
        {
          artifact: "worker",
          image: WORKER_IMG,
          service: serviceConfig({
            name: "worker-b",
            port: 9101,
            envs: ["candidate-a"],
          }),
        },
      ],
    };

    const resolved = resolveNodeArtifactBundleForEnvironment(
      shared,
      "production"
    );

    // worker-b is dropped, but worker-a still references the shared "worker" artifact,
    // so the artifact SURVIVES — no over-drop.
    expect(resolved.services.map(({ service }) => service.name)).toEqual([
      "app",
      "worker-a",
    ]);
    expect(resolved.artifacts.map((artifact) => artifact.name)).toEqual([
      "app",
      "worker",
    ]);
    expect(everyArtifactUsed(resolved)).toBe(true);
    expect(everyServiceHasArtifact(resolved)).toBe(true);
  });

  it("is a no-op for an ungated bundle (every service in every env)", () => {
    const spec = multiServiceSpec();
    const resolved = resolveNodeArtifactBundle(spec, completeBundle(), {
      sourceSha: SOURCE_SHA,
      repository: "example/node",
    });
    for (const environment of [
      "candidate-a",
      "preview",
      "production",
    ] as const) {
      const perEnv = resolveNodeArtifactBundleForEnvironment(
        resolved,
        environment
      );
      expect(perEnv.artifacts).toEqual(resolved.artifacts);
      expect(perEnv.services).toEqual(resolved.services);
    }
  });
});
