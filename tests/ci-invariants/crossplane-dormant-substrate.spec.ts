// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/crossplane-dormant-substrate`
 * Purpose: Pins the Crossplane install boundary. task.5094 installed the engine; task.5096
 *   activated ONE composite API on top of it. What survives that handoff is the part that was
 *   never about dormancy: no credential and NO DESIRED STATE may live in this directory.
 * Scope: Static YAML checks over the candidate-a Argo Applications and Crossplane package manifests. Does NOT contact a cluster or provider.
 * Invariants: NO_DESIRED_STATE_IN_GIT, CANDIDATE_FIRST, IMMUTABLE_PACKAGES,
 *   RESOURCE_BOUNDED, OBSERVABLE_BEFORE_AUTHORITY, CONSTANT_TRACKS_INSTALLED_REALITY.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 R2, task.5094, task.5096, task.5104,
 *   src/shared/node-registry/crossplane-control-plane.ts, knowledge:akash-cicd-pareto-scope
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { CROSSPLANE_CONTROL_PLANE_ENVS } from "@/shared/node-registry/crossplane-control-plane";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CANDIDATE_CONTROL_PLANE = path.join(
  REPO_ROOT,
  "infra/k8s/argocd/control-plane/candidate-a"
);
const PACKAGE_DIR = path.join(REPO_ROOT, "infra/crossplane/install/packages");
const CROSSPLANE_DIR = path.join(REPO_ROOT, "infra/crossplane");
const CONTROL_PLANE_ROOT = path.join(
  REPO_ROOT,
  "infra/k8s/argocd/control-plane"
);
/** The Application whose presence MEANS "XComputeWorkload is an installed API in this env". */
const COMPOSITE_APPLICATION_FILE =
  "crossplane-xcomputeworkload-application.yaml";

type YamlObject = Record<string, unknown>;

function readYaml(file: string): YamlObject {
  return parse(readFileSync(file, "utf8")) as YamlObject;
}

function readYamlDocuments(file: string): YamlObject[] {
  return parseAllDocuments(readFileSync(file, "utf8"))
    .map((document) => document.toJS() as unknown)
    .filter(
      (value): value is YamlObject =>
        !!value && typeof value === "object" && !Array.isArray(value)
    );
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return yamlFiles(fullPath);
      return /\.ya?ml$/.test(entry.name) ? [fullPath] : [];
    })
    .sort();
}

const coreApplication = readYaml(
  path.join(CANDIDATE_CONTROL_PLANE, "crossplane-core-application.yaml")
);
const packagesApplication = readYaml(
  path.join(CANDIDATE_CONTROL_PLANE, "crossplane-packages-application.yaml")
);
const compositeApplication = readYaml(
  path.join(
    CANDIDATE_CONTROL_PLANE,
    "crossplane-xcomputeworkload-application.yaml"
  )
);
const packageDocuments = yamlFiles(PACKAGE_DIR)
  .filter((file) => path.basename(file) !== "kustomization.yaml")
  .flatMap(readYamlDocuments);
const crossplaneDocuments =
  yamlFiles(CROSSPLANE_DIR).flatMap(readYamlDocuments);

function metadataName(document: YamlObject): string {
  return ((document.metadata as YamlObject | undefined)?.name as string) ?? "";
}

function packageSpec(document: YamlObject): YamlObject {
  return document.spec as YamlObject;
}

describe("Crossplane substrate boundary (task.5094, task.5096)", () => {
  it("is activated by candidate-a only", () => {
    for (const environment of ["preview", "production"]) {
      const files = readdirSync(path.join(CONTROL_PLANE_ROOT, environment));
      expect(files.filter((file) => file.includes("crossplane"))).toEqual([]);
    }

    expect(metadataName(coreApplication)).toBe("crossplane-core");
    expect(metadataName(packagesApplication)).toBe("crossplane-packages");
    expect(metadataName(compositeApplication)).toBe(
      "crossplane-xcomputeworkload"
    );
  });

  /**
   * CONSTANT_TRACKS_INSTALLED_REALITY (task.5104). `CROSSPLANE_CONTROL_PLANE_ENVS` is what the
   * operator's TypeScript believes about where an `XComputeWorkload` can be reconciled — the
   * node-formation generator filters a birth's `compute_api` through it, and
   * `resolveNodeComputeApi` throws on any row that names `crossplane` outside it. Belief and
   * git must be the same set in BOTH directions:
   *   - an env in the constant with no control plane → the wizard mints a row whose promote
   *     renders a composite into a cluster with no such CRD, reconciled by nobody;
   *   - an env with a control plane missing from the constant → the guard rejects a legitimate
   *     row and blocks the very cutover the install was for.
   * So installing Crossplane on preview/production is DELIBERATELY a red build until this
   * constant is widened in the same PR.
   */
  it("names exactly the environments whose control plane installs the composite API", () => {
    const installed = readdirSync(CONTROL_PLANE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((environment) =>
        readdirSync(path.join(CONTROL_PLANE_ROOT, environment)).includes(
          COMPOSITE_APPLICATION_FILE
        )
      )
      .sort();

    expect(installed).toEqual(["candidate-a"]);
    expect([...CROSSPLANE_CONTROL_PLANE_ENVS].sort()).toEqual(installed);
  });

  it("pins the core chart and runtime image, bounds resources, and exposes metrics", () => {
    const source = (coreApplication.spec as YamlObject).source as YamlObject;
    expect(source.targetRevision).toBe("2.4.0");

    const helmValues = parse(
      ((source.helm as YamlObject).values as string) ?? ""
    ) as YamlObject;
    const image = helmValues.image as YamlObject;
    expect(image.repository).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(image.ignoreTag).toBe(true);
    expect((helmValues.metrics as YamlObject).enabled).toBe(true);
    expect((helmValues.provider as YamlObject).defaultActivations).toEqual([]);

    for (const key of ["resourcesCrossplane", "resourcesRBACManager"]) {
      const resources = helmValues[key] as YamlObject;
      expect(resources.requests).toMatchObject({
        cpu: expect.any(String),
        memory: expect.any(String),
      });
      expect(resources.limits).toMatchObject({
        cpu: expect.any(String),
        memory: expect.any(String),
      });
    }
    expect(helmValues.packageCache).toMatchObject({
      medium: "Memory",
      sizeLimit: expect.any(String),
    });
    expect(helmValues.functionCache).toMatchObject({
      medium: "Memory",
      sizeLimit: expect.any(String),
    });
  });

  it("installs only pinned, resource-bounded package runtimes", () => {
    expect(packageDocuments.map((document) => document.kind).sort()).toEqual([
      "DeploymentRuntimeConfig",
      "Function",
      "Function",
      "Provider",
    ]);

    const packages = packageDocuments.filter((document) =>
      ["Function", "Provider"].includes(document.kind as string)
    );
    expect(packages.map(metadataName).sort()).toEqual([
      "function-auto-ready",
      "function-go-templating",
      "provider-http",
    ]);
    for (const document of packages) {
      const spec = packageSpec(document);
      expect(spec.package).toMatch(/:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
      expect(spec.runtimeConfigRef).toEqual({
        name: "crossplane-dormant-runtime",
      });
    }

    const runtime = packageDocuments.find(
      (document) => document.kind === "DeploymentRuntimeConfig"
    );
    const deployment = (
      (runtime?.spec as YamlObject).deploymentTemplate as YamlObject
    ).spec as YamlObject;
    expect(deployment.replicas).toBe(1);
    const podTemplate = deployment.template as YamlObject;
    const podSpec = podTemplate.spec as YamlObject;
    const containers = podSpec.containers as YamlObject[];
    const resources = containers.find(
      (container) => container.name === "package-runtime"
    )?.resources as YamlObject;
    expect(resources.requests).toMatchObject({
      cpu: expect.any(String),
      memory: expect.any(String),
    });
    expect(resources.limits).toMatchObject({
      cpu: expect.any(String),
      memory: expect.any(String),
    });
  });

  /**
   * task.5096 deliberately ADDED an XRD, a Composition, an activation policy and a
   * credential-free ClusterProviderConfig here — that is the authority handoff, and it is
   * reviewed as its own change. What must never appear is the other half: a secret value, or
   * an INSTANCE. An API cannot spend money; a desired-state object can. `Request` is the
   * managed resource the Composition composes at runtime and `XComputeWorkload` is the
   * composite an environment overlay commits — a copy of either one in this directory would
   * be a paid workload nobody scoped to an environment.
   */
  it("contains no credential and no desired-state instance", () => {
    const forbiddenKinds = new Set([
      "ProviderConfig",
      "ExternalSecret",
      "Secret",
      "Request",
      "DisposableRequest",
      "DNSEndpoint",
      "ComputeWorkload",
      "XComputeWorkload",
    ]);
    expect(
      crossplaneDocuments
        .filter((document) => forbiddenKinds.has(document.kind as string))
        .map((document) => `${document.kind}/${metadataName(document)}`)
    ).toEqual([]);
  });

  it("keeps every child Application self-healing but non-pruning", () => {
    for (const application of [
      coreApplication,
      packagesApplication,
      compositeApplication,
    ]) {
      const syncPolicy = (application.spec as YamlObject)
        .syncPolicy as YamlObject;
      expect(syncPolicy.automated).toEqual({ prune: false, selfHeal: true });
    }
  });
});
