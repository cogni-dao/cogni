// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/crossplane-dormant-substrate`
 * Purpose: Pins the Crossplane install boundary. task.5094 installed the engine; task.5096
 *   activated ONE composite API on top of it. What survives that handoff is the part that was
 *   never about dormancy: no credential and NO DESIRED STATE may live in this directory.
 * Scope: Static YAML checks over every environment's Argo Applications plus the shared Crossplane package manifests. Does NOT contact a cluster, a provider, or a wallet.
 * Invariants: NO_DESIRED_STATE_IN_GIT, ENGINE_IS_UNIFORM_ACROSS_ENVS, IMMUTABLE_PACKAGES,
 *   RESOURCE_BOUNDED, OBSERVABLE_BEFORE_AUTHORITY, CONSTANT_TRACKS_INSTALLED_REALITY,
 *   INSTALLED_IS_NOT_FUNDED.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 R2, task.5094, task.5096, task.5097, task.5104,
 *   src/shared/node-registry/crossplane-control-plane.ts, knowledge:akash-cicd-pareto-scope
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import {
  CROSSPLANE_ACTUATOR_WALLET_ENVS,
  CROSSPLANE_CONTROL_PLANE_ENVS,
} from "@/shared/node-registry/crossplane-control-plane";

const REPO_ROOT = path.resolve(__dirname, "../..");
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

/** The three Applications that make up one environment's Crossplane control plane. */
interface ControlPlaneApplications {
  readonly core: YamlObject;
  readonly packages: YamlObject;
  readonly composite: YamlObject;
}

function controlPlaneApplications(
  environment: string
): ControlPlaneApplications {
  const dir = path.join(CONTROL_PLANE_ROOT, environment);
  return {
    core: readYaml(path.join(dir, "crossplane-core-application.yaml")),
    packages: readYaml(path.join(dir, "crossplane-packages-application.yaml")),
    composite: readYaml(path.join(dir, COMPOSITE_APPLICATION_FILE)),
  };
}

/**
 * Environments whose control plane installs the composite API, derived from GIT rather than from
 * the constant. Deriving it this way (not from `CROSSPLANE_CONTROL_PLANE_ENVS`) is deliberate: a
 * constant naming an env with no manifests must fail as a readable assertion below, not as an
 * ENOENT at module collection time that never reaches the assertion at all.
 */
const INSTALLED_ENVS = readdirSync(CONTROL_PLANE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((environment) =>
    readdirSync(path.join(CONTROL_PLANE_ROOT, environment)).includes(
      COMPOSITE_APPLICATION_FILE
    )
  )
  .sort();

const APPLICATIONS_BY_ENV = new Map<string, ControlPlaneApplications>(
  INSTALLED_ENVS.map((environment) => [
    environment,
    controlPlaneApplications(environment),
  ])
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

function applicationSource(application: YamlObject): YamlObject {
  return (application.spec as YamlObject).source as YamlObject;
}

function targetRevision(application: YamlObject): unknown {
  return applicationSource(application).targetRevision;
}

function helmValues(application: YamlObject): YamlObject {
  const source = applicationSource(application);
  return parse(
    ((source.helm as YamlObject).values as string) ?? ""
  ) as YamlObject;
}

/**
 * The PUBLIC Akash account the `akash-tx-actuator` Deployment is pinned to in `environment`'s
 * operator overlay, or `""` when it is deliberately unpinned. Read from the BY-NAME strategic
 * merge patch (story.5016 Gate 0b) rather than the base default, because the overlay is the
 * cutover seam a human edits.
 */
function actuatorAccountId(environment: string): string {
  const overlay = parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        `infra/k8s/overlays/${environment}/operator/kustomization.yaml`
      ),
      "utf8"
    )
  ) as { patches?: { target?: YamlObject; patch?: string }[] };

  const patch = overlay.patches?.find(
    (entry) =>
      entry.target?.kind === "Deployment" &&
      entry.target?.name === "akash-tx-actuator"
  )?.patch;
  if (!patch) return "";

  const merged = parse(patch) as YamlObject;
  const containers = (
    (((merged.spec as YamlObject).template as YamlObject).spec as YamlObject)
      .containers as YamlObject[]
  ).find((container) => container.name === "actuator");
  const env = (containers?.env ?? []) as { name: string; value?: string }[];
  return (
    env.find((entry) => entry.name === "AKASH_ACTUATOR_ACCOUNT_ID")?.value ?? ""
  );
}

describe("Crossplane substrate boundary (task.5094, task.5096, task.5097)", () => {
  /**
   * ENGINE_IS_UNIFORM_ACROSS_ENVS (task.5097). Every environment that claims a control plane
   * ships the SAME three Applications, under the same names. A per-env engine — a different
   * chart, a different image digest, a missing activation Application — is a control plane whose
   * candidate-a proof transfers to nothing.
   */
  it("installs the same three named Applications in every environment it claims", () => {
    for (const [environment, applications] of APPLICATIONS_BY_ENV) {
      expect(metadataName(applications.core), environment).toBe(
        "crossplane-core"
      );
      expect(metadataName(applications.packages), environment).toBe(
        "crossplane-packages"
      );
      expect(metadataName(applications.composite), environment).toBe(
        "crossplane-xcomputeworkload"
      );
    }
  });

  /**
   * CANDIDATE_IS_THE_ONLY_UNMERGED_TREE. candidate-a tracks a deploy ref because it is the proof
   * slot: the production operator fast-forwards `deploy/candidate-a-control-plane` to an exact
   * reviewed head via POST /api/v1/deploy/infra-reconcile, so a control-plane shape can be proven
   * BEFORE it merges. Every downstream environment must track `main` — a preview or production
   * cluster running a control plane that never merged is the failure this asymmetry prevents.
   */
  it("lets only candidate-a run an unmerged control-plane tree", () => {
    for (const [environment, applications] of APPLICATIONS_BY_ENV) {
      // The pinned package set is shared source with no per-env shape: always main.
      expect(
        targetRevision(applications.packages),
        `${environment}/crossplane-packages`
      ).toBe("main");
      expect(
        targetRevision(applications.composite),
        `${environment}/crossplane-xcomputeworkload`
      ).toBe(
        environment === "candidate-a"
          ? "deploy/candidate-a-control-plane"
          : "main"
      );
    }
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
   * So installing Crossplane on preview/production was DELIBERATELY a red build until this
   * constant was widened in the same PR — which is exactly what task.5097 did. The assertion is
   * now derived from git in both directions rather than pinned to a literal, so the next env to
   * gain or lose a control plane still cannot drift from what the operator believes.
   */
  it("names exactly the environments whose control plane installs the composite API", () => {
    expect([...CROSSPLANE_CONTROL_PLANE_ENVS].sort()).toEqual(INSTALLED_ENVS);
  });

  /**
   * INSTALLED_IS_NOT_FUNDED (task.5097). An installed control plane can RECONCILE a composite;
   * only a pinned wallet can PAY for one. `CROSSPLANE_ACTUATOR_WALLET_ENVS` is what the operator
   * believes about the second fact, and the git truth is the non-empty `AKASH_ACTUATOR_ACCOUNT_ID`
   * on that env's `akash-tx-actuator` Deployment patch. Both directions are failures:
   *   - listed but unpinned → node births mint `compute_api.<env>: crossplane` rows whose every
   *     paid transaction is refused with `actuator_account_id_missing`;
   *   - pinned but unlisted → a funded, cut-over environment silently keeps minting births onto
   *     the retiring bespoke controller.
   * A wallet env must also have a control plane: paying for a composite nothing reconciles is
   * strictly worse than not paying.
   */
  it("names exactly the environments whose actuator pins a wallet account", () => {
    const pinned = INSTALLED_ENVS.filter(
      (environment) => actuatorAccountId(environment).length > 0
    ).sort();

    expect([...CROSSPLANE_ACTUATOR_WALLET_ENVS].sort()).toEqual(pinned);
    for (const environment of CROSSPLANE_ACTUATOR_WALLET_ENVS) {
      expect(
        [...CROSSPLANE_CONTROL_PLANE_ENVS],
        `${environment} pins a wallet but installs no control plane`
      ).toContain(environment);
    }
  });

  it("reuses the managed test account only across candidate-a and preview", () => {
    const candidateAccount = actuatorAccountId("candidate-a");
    const previewAccount = actuatorAccountId("preview");
    const productionAccount = actuatorAccountId("production");

    expect(candidateAccount).not.toBe("");
    expect(previewAccount).toBe(candidateAccount);
    expect(productionAccount).not.toBe("");
    expect(productionAccount).not.toBe(candidateAccount);
  });

  it("pins the core chart and runtime image, bounds resources, and exposes metrics", () => {
    for (const [environment, applications] of APPLICATIONS_BY_ENV) {
      expect(targetRevision(applications.core), environment).toBe("2.4.0");

      const values = helmValues(applications.core);
      const image = values.image as YamlObject;
      expect(image.repository, environment).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(image.ignoreTag, environment).toBe(true);
      expect((values.metrics as YamlObject).enabled, environment).toBe(true);
      expect(
        (values.provider as YamlObject).defaultActivations,
        environment
      ).toEqual([]);

      for (const key of ["resourcesCrossplane", "resourcesRBACManager"]) {
        const resources = values[key] as YamlObject;
        expect(resources.requests, `${environment}/${key}`).toMatchObject({
          cpu: expect.any(String),
          memory: expect.any(String),
        });
        expect(resources.limits, `${environment}/${key}`).toMatchObject({
          cpu: expect.any(String),
          memory: expect.any(String),
        });
      }
      expect(values.packageCache, environment).toMatchObject({
        medium: "Memory",
        sizeLimit: expect.any(String),
      });
      expect(values.functionCache, environment).toMatchObject({
        medium: "Memory",
        sizeLimit: expect.any(String),
      });
    }
  });

  /**
   * ENGINE_IS_UNIFORM_ACROSS_ENVS (task.5097). The engine candidate-a proved is the engine every
   * environment runs: not "a pinned digest each", ONE digest. Three independently-pinned copies
   * would let preview or production drift onto a Crossplane build no candidate ever exercised,
   * which is the whole value of a proof slot thrown away silently.
   */
  it("runs the identical pinned engine in every environment", () => {
    const engines = new Set(
      [...APPLICATIONS_BY_ENV.values()].map((applications) =>
        JSON.stringify({
          chart: targetRevision(applications.core),
          image: (helmValues(applications.core).image as YamlObject).repository,
        })
      )
    );
    expect([...engines]).toHaveLength(1);

    // PACKAGES_ARE_IMMUTABLE holds by CONSTRUCTION, not by copy: every env's packages
    // Application points at the one shared path, so there is no second digest to drift.
    const paths = new Set(
      [...APPLICATIONS_BY_ENV.values()].map(
        (applications) => applicationSource(applications.packages).path
      )
    );
    expect([...paths]).toEqual(["infra/crossplane/install/packages"]);

    const compositePaths = new Set(
      [...APPLICATIONS_BY_ENV.values()].map(
        (applications) => applicationSource(applications.composite).path
      )
    );
    expect([...compositePaths]).toEqual(["infra/crossplane/xcomputeworkload"]);
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
    for (const [environment, applications] of APPLICATIONS_BY_ENV) {
      for (const application of [
        applications.core,
        applications.packages,
        applications.composite,
      ]) {
        const syncPolicy = (application.spec as YamlObject)
          .syncPolicy as YamlObject;
        expect(
          syncPolicy.automated,
          `${environment}/${metadataName(application)}`
        ).toEqual({ prune: false, selfHeal: true });
      }
    }
  });
});
