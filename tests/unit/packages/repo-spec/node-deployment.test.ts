// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/node-deployment`
 * Purpose: Prove the provider-neutral node services and sibling binding declaration.
 * Scope: Pure repo-spec parsing and typed extraction. Does not perform deployment or provider I/O.
 * Invariants: LEGACY_DEFAULT, ONE_PUBLIC_SERVICE, APP_ONLY, BIND_ALL_INTERFACES.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, task.5065
 * @public
 */

import {
  COGNI_NODE_APP_V1_DEPLOYMENT,
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  extractNodeServices,
  hasDeclaredNodeDeployment,
  LEGACY_DEFAULT_NODE_DEPLOYMENT,
  missingRuntimeProfileSecretKeys,
  parseRepoSpec,
  renderNodeDeploymentYaml,
} from "@cogni/repo-spec";
import {
  buildTestRepoSpec,
  buildTestRepoSpecYaml,
} from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const APP = {
  name: "app",
  artifact: { name: "app" },
  port: 3200,
  visibility: "public",
  resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
} as const;

describe("node deployment repo-spec", () => {
  it("preserves the real node-template behavior when deployment is omitted", () => {
    expect(extractNodeServices(buildTestRepoSpec())).toEqual([
      {
        name: "app",
        artifact: {
          name: "app",
          context: ".",
          dockerfile: "Dockerfile",
          target: "runner",
        },
        port: 3200,
        visibility: "public",
        runtimeProfile: "cogni-node-app-v1",
        bindings: {},
        secretRefs: [],
        bindHost: "0.0.0.0",
        internalUrl: "http://app:3200",
        resources: {
          cpuUnits: 2,
          memoryMi: 2048,
          storageMi: 4096,
        },
      },
    ]);
  });

  it("declares one public app and a private service without provider vocabulary", () => {
    const spec = buildTestRepoSpec({
      deployment: {
        services: [
          APP,
          {
            name: "echo-sidecar",
            artifact: {
              name: "echo-sidecar",
              context: "services/echo-sidecar",
              dockerfile: "services/echo-sidecar/Dockerfile",
            },
            command: ["node", "server.mjs"],
            args: ["--host", "0.0.0.0", "--port", "9100"],
            port: 9100,
            visibility: "private",
            resources: {
              cpu_units: 2,
              memory_mi: 16384,
              storage_mi: 65536,
            },
          },
        ],
      },
    });

    expect(extractNodeServices(spec)[1]).toEqual({
      name: "echo-sidecar",
      artifact: {
        name: "echo-sidecar",
        context: "services/echo-sidecar",
        dockerfile: "services/echo-sidecar/Dockerfile",
      },
      command: ["node", "server.mjs"],
      args: ["--host", "0.0.0.0", "--port", "9100"],
      port: 9100,
      visibility: "private",
      bindings: {},
      secretRefs: [],
      bindHost: "0.0.0.0",
      internalUrl: "http://echo-sidecar:9100",
      resources: { cpuUnits: 2, memoryMi: 16384, storageMi: 65536 },
    });
  });

  it("allows services to reuse one artifact image", () => {
    const spec = buildTestRepoSpec({
      deployment: {
        services: [
          APP,
          {
            name: "worker",
            artifact: { name: "app" },
            command: ["node"],
            args: ["worker.mjs"],
            port: 9100,
            visibility: "private",
            resources: {
              cpu_units: 0.5,
              memory_mi: 1024,
              storage_mi: 2048,
            },
          },
        ],
      },
    });

    expect(
      extractNodeServices(spec).map((service) => service.artifact.name)
    ).toEqual(["app", "app"]);
  });

  it("rejects conflicting build instructions for a reused artifact identity", () => {
    expect(() =>
      buildTestRepoSpec({
        deployment: {
          services: [
            APP,
            {
              name: "worker",
              artifact: { name: "app", dockerfile: "Worker.Dockerfile" },
              port: 9100,
              visibility: "private",
              resources: {
                cpu_units: 0.5,
                memory_mi: 1024,
                storage_mi: 2048,
              },
            },
          ],
        },
      })
    ).toThrow(/identical build instructions/);
  });

  it("resolves a bounded Git-declared binding to the sibling service contract", () => {
    const spec = buildTestRepoSpec({
      deployment: {
        services: [
          { ...APP, bindings: { ECHO_SIDECAR_URL: "echo-sidecar" } },
          {
            name: "echo-sidecar",
            artifact: { name: "echo-sidecar" },
            port: 9100,
            visibility: "private",
            resources: {
              cpu_units: 0.5,
              memory_mi: 1024,
              storage_mi: 2048,
            },
          },
        ],
      },
    });

    expect(extractNodeServices(spec)[0]?.bindings).toEqual({
      ECHO_SIDECAR_URL: "echo-sidecar",
    });
    expect(extractNodeServices(spec)[1]?.internalUrl).toBe(
      "http://echo-sidecar:9100"
    );
  });

  it("carries bounded value-free secret requirements", () => {
    const spec = buildTestRepoSpec({
      deployment: {
        services: [
          { ...APP, secret_refs: [{ key: "APP_TOKEN" }] },
          {
            name: "worker",
            artifact: { name: "worker" },
            port: 9100,
            visibility: "private",
            resources: {
              cpu_units: 0.5,
              memory_mi: 1024,
              storage_mi: 2048,
            },
          },
        ],
      },
    });
    expect(extractNodeServices(spec)[0]?.secretRefs).toEqual([
      { key: "APP_TOKEN" },
    ]);
  });

  it("keeps explicit services generic unless they opt into app compatibility", () => {
    expect(
      extractNodeServices(
        buildTestRepoSpec({ deployment: { services: [APP] } })
      )[0]
    ).not.toHaveProperty("runtimeProfile");

    const profiled = buildTestRepoSpec({
      deployment: {
        services: [{ ...APP, runtime_profile: "cogni-node-app-v1" }],
      },
    });
    expect(extractNodeServices(profiled)[0]?.runtimeProfile).toBe(
      "cogni-node-app-v1"
    );
  });

  it("rejects app compatibility on a private service", () => {
    expect(() =>
      buildTestRepoSpec({
        deployment: {
          services: [
            APP,
            {
              ...APP,
              name: "worker",
              artifact: { name: "worker" },
              visibility: "private",
              runtime_profile: "cogni-node-app-v1",
            },
          ],
        },
      })
    ).toThrow(/runtime_profile requires the public service/);
  });

  it.each([
    {
      name: "no public service",
      services: [{ ...APP, visibility: "private" }],
      message: /exactly one public service/,
    },
    {
      name: "two public services",
      services: [APP, { ...APP, name: "other" }],
      message: /exactly one public service/,
    },
    {
      name: "loopback bind",
      services: [{ ...APP, bind_host: "127.0.0.1" }],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "more than 32 args",
      services: [{ ...APP, args: Array.from({ length: 33 }, () => "arg") }],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "arg longer than 1024 characters",
      services: [{ ...APP, args: ["a".repeat(1025)] }],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "missing binding target",
      services: [{ ...APP, bindings: { ECHO_SIDECAR_URL: "echo-sidecar" } }],
      message: /binding target is not declared/,
    },
    {
      name: "secret value in Git",
      services: [
        { ...APP, secret_refs: [{ key: "APP_TOKEN", value: "forbidden" }] },
      ],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "binding and secret collision",
      services: [
        {
          ...APP,
          bindings: { APP_TOKEN: "worker" },
          secret_refs: [{ key: "APP_TOKEN" }],
        },
        { ...APP, name: "worker", visibility: "private" },
      ],
      message: /cannot be both a sibling binding and a secret ref/,
    },
  ])("rejects $name", ({ services, message }) => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: { services },
      })
    ).toThrow(message);
  });

  it("rejects implicit sizing for an explicitly declared service", () => {
    const { resources: _resources, ...appWithoutResources } = APP;
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: { services: [appWithoutResources] },
      })
    ).toThrow(/Invalid repo-spec structure/);
  });

  it("rejects partial explicit sizing", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [{ ...APP, resources: { cpu_units: 2 } }],
        },
      })
    ).toThrow(/Invalid repo-spec structure/);
  });

  it("does not infer statefulness from a generic service name", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [APP, { ...APP, name: "redis", visibility: "private" }],
        },
      })
    ).not.toThrow();
  });

  it("rejects unsupported persistent-state fields structurally", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [
            {
              ...APP,
              persistent_volume: { size_mi: 1024 },
            },
          ],
        },
      })
    ).toThrow(/Invalid repo-spec structure/);
  });
});

describe("cogni-node-app-v1 deployment contract", () => {
  it("distinguishes a declared block from the legacy fallback", () => {
    expect(hasDeclaredNodeDeployment(buildTestRepoSpec())).toBe(false);
    expect(
      hasDeclaredNodeDeployment(
        buildTestRepoSpec({ deployment: COGNI_NODE_APP_V1_DEPLOYMENT })
      )
    ).toBe(true);
  });

  it("keeps the legacy fallback secret-free so k3s nodes are untouched", () => {
    expect(LEGACY_DEFAULT_NODE_DEPLOYMENT.services[0]?.secret_refs).toEqual([]);
    expect(extractNodeServices(buildTestRepoSpec())[0]?.secretRefs).toEqual([]);
  });

  it("declares every key the runtime profile requires", () => {
    expect(
      COGNI_NODE_APP_V1_DEPLOYMENT.services[0]?.secret_refs.map(
        (ref) => ref.key
      )
    ).toEqual([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS]);
    expect(
      missingRuntimeProfileSecretKeys({
        runtimeProfile: "cogni-node-app-v1",
        secretRefs: COGNI_NODE_APP_V1_DEPLOYMENT.services[0]?.secret_refs ?? [],
      })
    ).toEqual([]);
    expect(
      missingRuntimeProfileSecretKeys({
        runtimeProfile: "cogni-node-app-v1",
        secretRefs:
          LEGACY_DEFAULT_NODE_DEPLOYMENT.services[0]?.secret_refs ?? [],
      })
    ).toEqual([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS]);
    // A service without the profile owes nothing — the contract is capability-scoped.
    expect(missingRuntimeProfileSecretKeys({ secretRefs: [] })).toEqual([]);
  });

  it("renders a YAML block that round-trips through the schema", () => {
    const rendered = renderNodeDeploymentYaml();
    expect(parseYaml(rendered)).toEqual({
      deployment: COGNI_NODE_APP_V1_DEPLOYMENT,
    });
    // Authored as a node repo would: raw YAML text through the real parser.
    const spec = parseRepoSpec(buildTestRepoSpecYaml({ extra: rendered }));
    expect(spec.deployment).toEqual(COGNI_NODE_APP_V1_DEPLOYMENT);
  });
});
