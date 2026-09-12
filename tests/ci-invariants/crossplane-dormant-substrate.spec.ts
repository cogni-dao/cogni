// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/crossplane-dormant-substrate`
 * Purpose: Pins task.5094's dormant Crossplane install boundary before any workload authority moves.
 * Scope: Static YAML checks over the candidate-a Argo Applications and Crossplane package manifests. Does NOT contact a cluster or provider.
 * Invariants: DORMANT_MEANS_ZERO_AUTHORITY, CANDIDATE_FIRST, IMMUTABLE_PACKAGES,
 *   RESOURCE_BOUNDED, OBSERVABLE_BEFORE_AUTHORITY.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 R2, task.5094, knowledge:akash-cicd-pareto-scope
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CANDIDATE_CONTROL_PLANE = path.join(
  REPO_ROOT,
  "infra/k8s/argocd/control-plane/candidate-a"
);
const PACKAGE_DIR = path.join(REPO_ROOT, "infra/crossplane/install/packages");
const CROSSPLANE_DIR = path.join(REPO_ROOT, "infra/crossplane");

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

describe("dormant Crossplane substrate (task.5094)", () => {
  it("is activated by candidate-a only", () => {
    for (const environment of ["preview", "production"]) {
      const files = readdirSync(
        path.join(REPO_ROOT, "infra/k8s/argocd/control-plane", environment)
      );
      expect(files.filter((file) => file.includes("crossplane"))).toEqual([]);
    }

    expect(metadataName(coreApplication)).toBe("crossplane-core");
    expect(metadataName(packagesApplication)).toBe("crossplane-packages");
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

  it("contains no credential, desired-state, or external-write object", () => {
    const forbiddenKinds = new Set([
      "CompositeResourceDefinition",
      "Composition",
      "ProviderConfig",
      "ExternalSecret",
      "Secret",
      "Request",
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

  it("keeps both child Applications self-healing but non-pruning", () => {
    for (const application of [coreApplication, packagesApplication]) {
      const syncPolicy = (application.spec as YamlObject)
        .syncPolicy as YamlObject;
      expect(syncPolicy.automated).toEqual({ prune: false, selfHeal: true });
    }
  });
});
