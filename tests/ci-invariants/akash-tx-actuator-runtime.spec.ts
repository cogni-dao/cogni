// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/akash-tx-actuator-runtime`
 * Purpose: Pin the seams that decide whether Crossplane can REACH the Akash transaction actuator.
 *   Each one is a silent, deploy-time-only failure otherwise: nothing in CI builds these
 *   overlays, and the symptom is a connection error hours later on a manifest that renders
 *   perfectly (task.5102).
 * Scope: Static assertions over the app-lane manifests + the image entrypoint wiring; does not
 *   render kustomize, reach a cluster, or touch a provider.
 * Invariants:
 *   - ADDRESS_IS_THE_CONTRACT: the Service is named exactly `akash-tx-actuator` on port 8080,
 *     and the overlay's `operator-` namePrefix is undone for it.
 *   - PRIVATE_BY_CONSTRUCTION: ClusterIP only — no Ingress, no NodePort, no public route.
 *   - LEAST_PRIVILEGE_CREDENTIALS: an explicit projected key list, never `envFrom` over the
 *     whole operator Secret.
 *   - ENTRYPOINT_EXISTS: the Deployment's command path is the path the Dockerfile copies.
 * Side-effects: IO (reads infra/k8s/** + the operator Dockerfile/package.json)
 * Links: infra/k8s/base/akash-tx-actuator, infra/crossplane/xcomputeworkload/composition.yaml,
 *   nodes/operator/app/src/bootstrap/akash-tx-actuator.ts, task.5102
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;

/**
 * The exact address `infra/crossplane/xcomputeworkload/composition.yaml` builds from the
 * XR's namespace. It cannot know a kustomize prefix, so these three literals are a wire
 * contract, not a preference.
 */
const SERVICE_NAME = "akash-tx-actuator";
const SERVICE_PORT = 8080;
const AUTH_SECRET_NAME = "akash-tx-actuator-auth";
const AUTH_SECRET_KEY = "token";

const BASE = "infra/k8s/base/akash-tx-actuator";
const OVERLAY = "infra/k8s/overlays/candidate-a/operator";

interface K8sObject {
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: Record<string, unknown>;
}

const service = parse<K8sObject>(`${BASE}/service.yaml`);
const deployment = parse<K8sObject>(`${BASE}/deployment.yaml`);
const overlay = parse<{
  readonly resources: readonly string[];
  readonly transformers?: readonly string[];
  readonly namePrefix?: string;
}>(`${OVERLAY}/kustomization.yaml`);

function container(): Record<string, unknown> {
  const spec = deployment.spec as {
    template: { spec: { containers: Record<string, unknown>[] } };
  };
  const found = spec.template.spec.containers[0];
  expect(found).toBeDefined();
  return found as Record<string, unknown>;
}

describe("akash-tx-actuator runtime", () => {
  it("serves at the exact address the Composition dials", () => {
    expect(service.metadata.name).toBe(SERVICE_NAME);
    expect(service.spec.type).toBe("ClusterIP");
    expect(service.spec.ports).toEqual([
      { name: "http", port: SERVICE_PORT, targetPort: "http", protocol: "TCP" },
    ]);
    expect(container().ports).toEqual([
      { name: "http", containerPort: SERVICE_PORT },
    ]);
  });

  it("undoes the overlay namePrefix for that Service", () => {
    // Without the post-prefix transformer the object renders as
    // `operator-akash-tx-actuator` and EVERY Crossplane OBSERVE is connection-refused.
    expect(overlay.namePrefix).toBe("operator-");
    expect(overlay.resources).toContain(`../../../base/${SERVICE_NAME}`);
    expect(overlay.transformers).toContain(
      `../../../base/${SERVICE_NAME}-service-name`
    );
    const transformer = parse<{
      readonly patch: string;
      readonly target: Record<string, unknown>;
    }>(`infra/k8s/base/${SERVICE_NAME}-service-name/service-name.yaml`);
    expect(JSON.parse(transformer.patch)).toEqual([
      { op: "replace", path: "/metadata/name", value: SERVICE_NAME },
    ]);
    expect(transformer.target).toMatchObject({ kind: "Service" });
  });

  it("stays private: no Ingress, no NodePort, no public route", () => {
    const manifests = `${read(`${BASE}/service.yaml`)}\n${read(
      `${BASE}/deployment.yaml`
    )}`;
    expect(manifests).not.toMatch(/kind:\s*Ingress/);
    expect(manifests).not.toMatch(/nodePort/);
    expect(service.spec).not.toHaveProperty("externalIPs");
  });

  it("receives only the four credentials it needs, as files", () => {
    // envFrom over operator-env-secrets would hand a wallet writer the whole operator
    // bucket; an explicit item list is the blast radius we actually want.
    expect(container()).not.toHaveProperty("envFrom");
    const volumes = (
      deployment.spec as {
        template: { spec: { volumes: Record<string, unknown>[] } };
      }
    ).template.spec.volumes;
    const projected = volumes[0] as {
      projected: {
        sources: { secret: { name: string; items: { key: string }[] } }[];
      };
    };
    const source = projected.projected.sources[0];
    expect(source?.secret.name).toBe("operator-env-secrets");
    expect(source?.secret.items.map((item) => item.key)).toEqual([
      "AKASH_ACTUATOR_CONSOLE_API_KEY",
      "AKASH_CONSOLE_API_KEY",
      "AKASH_TX_ACTUATOR_TOKEN",
      "DATABASE_URL",
    ]);
    // Not `optional: true`: a missing dedicated wallet must CrashLoop, never silently
    // fall back to the legacy controller's Console account (ONE_WALLET_ONE_WRITER).
    expect(source?.secret).not.toHaveProperty("optional");
  });

  it("projects the bearer token under the name the provider-http placeholder dereferences", () => {
    const external = parse<{
      spec: {
        target: { name: string };
        data: { secretKey: string; remoteRef: { property: string } }[];
      };
    }>(`${OVERLAY}/akash-tx-actuator-auth-external-secret.yaml`);
    expect(external.spec.target.name).toBe(AUTH_SECRET_NAME);
    expect(external.spec.data).toHaveLength(1);
    expect(external.spec.data[0]?.secretKey).toBe(AUTH_SECRET_KEY);
    // Same OpenBao key the pod reads, so the two sides cannot drift.
    expect(external.spec.data[0]?.remoteRef.property).toBe(
      "AKASH_TX_ACTUATOR_TOKEN"
    );
    expect(overlay.resources).toContain(
      "./akash-tx-actuator-auth-external-secret.yaml"
    );
  });

  it("starts an entrypoint the image actually contains", () => {
    const entrypoint = `/app/nodes/operator/app/${SERVICE_NAME}.mjs`;
    expect(container().command).toEqual(["node", entrypoint]);
    const dockerfile = read("nodes/operator/app/Dockerfile");
    expect(dockerfile).toContain(
      `dist-${SERVICE_NAME}/${SERVICE_NAME}.mjs ./nodes/operator/app/${SERVICE_NAME}.mjs`
    );
    expect(dockerfile).toContain(
      `pnpm --filter operator build:${SERVICE_NAME}`
    );
    const pkg = JSON.parse(read("nodes/operator/app/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts[`build:${SERVICE_NAME}`]).toBe(
      `tsup --config tsup.${SERVICE_NAME}.config.ts`
    );
    const tsup = read(`nodes/operator/app/tsup.${SERVICE_NAME}.config.ts`);
    expect(tsup).toContain(`entry: ["src/bootstrap/${SERVICE_NAME}.ts"]`);
    expect(tsup).toContain(`outDir: "dist-${SERVICE_NAME}"`);
  });
});
