// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { parseRepoSpec, resolveNodeArtifactBundle } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  buildLegacyCogniAppWorkloadSpec,
  buildNodeServicesWorkloadSpec,
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
} from "./node-services-workload-spec";

const NODE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SHA = "a".repeat(40);
const APP_IMAGE = `ghcr.io/example/node@sha256:${"1".repeat(64)}`;
const WORKER_IMAGE = `ghcr.io/example/node-worker@sha256:${"2".repeat(64)}`;
const REQUIRED_SECRET_REFS = COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map(
  (key) => ({ key })
);

const spec = parseRepoSpec({
  node_id: NODE_ID,
  governance: {},
  deployment: {
    services: [
      {
        name: "app",
        artifact: { name: "app" },
        port: 3200,
        visibility: "public",
        runtime_profile: "cogni-node-app-v1",
        bindings: { WORKER_URL: "worker" },
        // The node declares NO profile secret_refs — the operator supplies them at build time.
        secret_refs: [],
        resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
      },
      {
        name: "worker",
        artifact: {
          name: "worker",
          dockerfile: "services/worker/Dockerfile",
        },
        command: ["python", "-m", "worker"],
        args: ["--host", "0.0.0.0", "--port", "9100"],
        port: 9100,
        visibility: "private",
        resources: { cpu_units: 0.25, memory_mi: 512, storage_mi: 1024 },
      },
    ],
  },
});

const bundle = resolveNodeArtifactBundle(
  spec,
  {
    schema_version: 1,
    node_id: NODE_ID,
    source: { repository: "example/node", sha: SOURCE_SHA },
    artifacts: [
      { name: "app", image: APP_IMAGE },
      { name: "worker", image: WORKER_IMAGE },
    ],
    services: [
      { name: "app", artifact: "app" },
      { name: "worker", artifact: "worker" },
    ],
  },
  { sourceSha: SOURCE_SHA, repository: "example/node" }
);

describe("buildNodeServicesWorkloadSpec", () => {
  it("builds one public app plus one non-global private sibling by digest", () => {
    const workload = buildNodeServicesWorkloadSpec({
      slug: "generic-node",
      bundle,
      hosts: ["node-test.example.org"],
    });

    expect(workload.services).toHaveLength(2);
    expect(workload.services[0]).toMatchObject({
      name: "app",
      image: APP_IMAGE,
      expose: [
        {
          port: 3200,
          as: 80,
          global: true,
          hosts: ["node-test.example.org"],
        },
      ],
      env: { WORKER_URL: "http://worker:9100" },
      // Supplied by the runtime profile even though the node declared none.
      secretRefs: REQUIRED_SECRET_REFS,
      runtimeProfile: "cogni-node-app-v1",
    });
    expect(workload.services[1]).toMatchObject({
      name: "worker",
      image: WORKER_IMAGE,
      command: ["python", "-m", "worker"],
      args: ["--host", "0.0.0.0", "--port", "9100"],
      expose: [{ port: 9100, as: 9100, global: false }],
    });
  });

  it("derives only topology/runtime env and applies no Cogni or framework policy", () => {
    const workload = buildNodeServicesWorkloadSpec({
      slug: "generic-node",
      bundle,
    });

    expect(workload.services[0]?.env).toEqual({
      WORKER_URL: "http://worker:9100",
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      PORT: "3200",
    });
    expect(workload.services[1]?.env).toEqual({
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      PORT: "9100",
    });
  });

  it("preserves existing Next.js defaults only through explicit compatibility", () => {
    const workload = buildLegacyCogniAppWorkloadSpec({
      slug: "legacy-node",
      bundle,
      publicUrl: "https://legacy-node.example.org",
    });

    expect(workload.services[0]?.env).toMatchObject({
      NODE_NAME: "legacy-node",
      COGNI_REPO_PATH: "/app",
      AUTH_TRUST_HOST: "true",
      NEXTAUTH_URL: "https://legacy-node.example.org",
      APP_BASE_URL: "https://legacy-node.example.org",
      WORKER_URL: "http://worker:9100",
    });
    expect(workload.services[1]?.env).toEqual({
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      PORT: "9100",
    });
  });

  it("does not infer Cogni compatibility from the public service name", () => {
    const genericBundle = {
      ...bundle,
      services: bundle.services.map(({ service, ...resolved }) => {
        const { runtimeProfile: _runtimeProfile, ...genericService } = service;
        return {
          ...resolved,
          service: genericService,
        };
      }),
    };

    expect(() =>
      buildLegacyCogniAppWorkloadSpec({
        slug: "generic-node",
        bundle: genericBundle,
        publicUrl: "https://generic-node.example.org",
      })
    ).toThrow(/exactly one public cogni-node-app-v1 service/);
  });

  it("supplies the profile's secret_refs, so a spec that omits (or predates) a key still flights (bug.5175)", () => {
    // Simulate a stale spec: it declares only AUTH_SECRET and is missing every other profile key
    // (the exact shape that made toks5 PR#2 unfliightable before this fix).
    const staleBundle = {
      ...bundle,
      services: bundle.services.map(({ service, ...resolved }, index) => ({
        ...resolved,
        service:
          index === 0
            ? { ...service, secretRefs: [{ key: "AUTH_SECRET" }] }
            : service,
      })),
    };

    const workload = buildNodeServicesWorkloadSpec({
      slug: "stale-node",
      bundle: staleBundle,
    });

    // The workload receives the FULL profile contract, deduped — no throw, no missing key.
    expect(workload.services[0]?.secretRefs).toEqual(REQUIRED_SECRET_REFS);
  });

  it("unions node-declared extras after the profile keys, deduped", () => {
    const extraBundle = {
      ...bundle,
      services: bundle.services.map(({ service, ...resolved }, index) => ({
        ...resolved,
        service:
          index === 0
            ? {
                ...service,
                // A profile key re-listed (deduped) plus one genuine extra.
                secretRefs: [{ key: "AUTH_SECRET" }, { key: "MY_EXTRA_KEY" }],
              }
            : service,
      })),
    };

    const workload = buildNodeServicesWorkloadSpec({
      slug: "extra-node",
      bundle: extraBundle,
    });

    expect(workload.services[0]?.secretRefs).toEqual([
      ...REQUIRED_SECRET_REFS,
      { key: "MY_EXTRA_KEY" },
    ]);
  });
});
