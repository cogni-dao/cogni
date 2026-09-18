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
 *   INSTALLED_IS_NOT_FUNDED, NO_CONSOLE_KEY_SLOT_OUTSIDE_A_WRITER.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 R2, task.5094, task.5096, task.5097, task.5104, task.5138,
 *   src/shared/node-registry/crossplane-control-plane.ts, knowledge:akash-cicd-pareto-scope,
 *   knowledge:akash-actuator-wallet-cutover
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import {
  CROSSPLANE_ACTUATOR_WALLET_ENVS,
  CROSSPLANE_ACTUATOR_WRITERS,
  CROSSPLANE_CONTROL_PLANE_ENVS,
  type CrossplaneActuatorWriter,
  writerFor,
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

/**
 * The OpenBao path an environment's actuator ExternalSecret pulls its Console credential from,
 * or "" when that environment ships no actuator ExternalSecret at all.
 *
 * This is the `remoteRef` half of the injectivity guard (bug.5187). Two environments naming the
 * SAME path hold the SAME Console credential, which is the same account — i.e. two writers on
 * one account, whatever their `AKASH_ACTUATOR_ACCOUNT_ID` pins happen to say. It is the exact
 * shape the north star calls out and REJECTS: putting the production Console key into a
 * pre-prod cluster, the obvious "smallest" shortcut.
 */
function actuatorSecretPath(environment: string): string {
  const file = path.join(
    REPO_ROOT,
    `infra/k8s/overlays/${environment}/operator/akash-tx-actuator-external-secret.yaml`
  );
  if (!existsSync(file)) return "";
  const document = readYaml(file);
  const dataFrom = ((document.spec as YamlObject).dataFrom ??
    []) as YamlObject[];
  const extract = dataFrom
    .map((entry) => (entry.extract as YamlObject | undefined)?.key)
    .find((key): key is string => typeof key === "string" && key.length > 0);
  return extract ?? "";
}

/** One writer's git-derived funding facts. `accountId`/`secretPath` are "" when absent. */
interface WriterBinding {
  readonly writerId: string;
  readonly cluster: string;
  readonly serves: readonly string[];
  readonly accountId: string;
  readonly secretPath: string;
}

function writerBindings(
  writers: readonly CrossplaneActuatorWriter[]
): WriterBinding[] {
  return writers.map((writer) => ({
    writerId: writer.id,
    cluster: writer.cluster,
    serves: writer.serves,
    accountId: actuatorAccountId(writer.cluster),
    secretPath: actuatorSecretPath(writer.cluster),
  }));
}

/** Values that appear on more than one binding — the injectivity violations, named. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);
  return [...seen.entries()]
    .filter(([value, count]) => count > 1 && value.length > 0)
    .map(([value]) => value)
    .sort();
}

/**
 * Every (environment, OWNER ORG) pair any writer claims to mint for, with the writers that claim
 * it. Keyed on the PAIR, not the environment (bug.5202): `candidate-a` is now legitimately
 * claimed by two writers — the production account for real `cogni-dao` nodes (NS3) and the
 * platform test account for `cogni-test-org` throwaway nodes (NS4). Per ENV that is two; per
 * PAIR it must still be exactly one, and that is the property worth guarding.
 */
function writersByServedPair(
  writers: readonly CrossplaneActuatorWriter[]
): Map<string, string[]> {
  const byPair = new Map<string, string[]>();
  for (const writer of writers) {
    for (const environment of writer.serves) {
      for (const owner of writer.owners) {
        const key = `${environment}|${owner}`;
        byPair.set(key, [...(byPair.get(key) ?? []), writer.id]);
      }
    }
  }
  return byPair;
}

/** Environments whose catalog rows select the Crossplane authority — i.e. that MUST be funded. */
const CROSSPLANE_SELECTED_PAIRS: readonly { env: string; owner: string }[] = [
  ...new Map(
    yamlFiles(path.join(REPO_ROOT, "infra/catalog"))
      .flatMap(readYamlDocuments)
      .flatMap((document) => {
        // The row's OWNER decides which account may pay for it. An in-repo row (no
        // `source_repo`) belongs to the monorepo org itself.
        const sourceRepo =
          typeof document.source_repo === "string" ? document.source_repo : "";
        const owner = sourceRepo
          ? (
              new URL(sourceRepo).pathname.split("/").filter(Boolean)[0] ?? ""
            ).toLowerCase()
          : "cogni-dao";
        return Object.entries(
          (document.compute_api as Record<string, string> | undefined) ?? {}
        )
          .filter(([, authority]) => authority === "crossplane")
          .map(([env]) => [`${env}|${owner}`, { env, owner }] as const);
      })
  ).values(),
].sort((a, b) => `${a.env}|${a.owner}`.localeCompare(`${b.env}|${b.owner}`));

const REAL_BINDINGS = writerBindings(CROSSPLANE_ACTUATOR_WRITERS);

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
   * So installing Crossplane on production (task.5097) and preview (task.5129) was DELIBERATELY
   * a red build until this constant was widened in the same PR. The assertion is now derived from
   * git in both directions rather than pinned to a literal, so the next env to gain or lose a
   * control plane still cannot drift from what the operator believes.
   */
  it("names exactly the environments whose control plane installs the composite API", () => {
    expect([...CROSSPLANE_CONTROL_PLANE_ENVS].sort()).toEqual(INSTALLED_ENVS);
  });

  /**
   * INSTALLED_IS_NOT_FUNDED (task.5097). An installed control plane can RECONCILE a composite;
   * only an actuator WRITER can PAY for one. `CROSSPLANE_ACTUATOR_WALLET_ENVS` — since bug.5187
   * derived from `CROSSPLANE_ACTUATOR_WRITERS`, so it means "the clusters that HOST a writer",
   * not "the environments whose leases are paid" — is what the operator believes about the
   * second fact, and the git truth is the non-empty `AKASH_ACTUATOR_ACCOUNT_ID` on that env's
   * `akash-tx-actuator` Deployment patch. Both directions are failures:
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

  /**
   * ONE_ACTIVE_WRITER_PER_ACCOUNT (story.5016, restated by bug.5187). Preview hosts NO writer —
   * it keeps an installed but unfunded control plane (INSTALLED_IS_NOT_FUNDED), so it can never
   * actuate an Akash tx. That matters because candidate-a and preview run SEPARATE per-env
   * Postgres ledgers and the single-writer guard (`akash_tx_allocations_single_writer_idx`) is
   * per-database: two WRITERS against one Console account cannot be serialized across two
   * ledgers, a double-spend hazard. Note what this test does NOT say: it says nothing about
   * which environments each account PAYS FOR, only that the two live writers hold two accounts.
   */
  it("preview hosts no writer; the two live writers hold two distinct accounts", () => {
    const candidateAccount = actuatorAccountId("candidate-a");
    const previewAccount = actuatorAccountId("preview");
    const productionAccount = actuatorAccountId("production");

    expect(previewAccount).toBe("");
    expect(candidateAccount).not.toBe("");
    expect(productionAccount).not.toBe("");
    expect(productionAccount).not.toBe(candidateAccount);
  });

  /**
   * ACCOUNT_IS_INJECTIVE_OVER_WRITERS (bug.5187) — the restatement.
   *
   * This test used to assert `account -> at most one ENVIRONMENT`. That was a correct PROXY only
   * while every writer served exactly its own environment, and under the north star — ONE
   * production Console account bills every real node in EVERY environment — it forbids the
   * target design outright. The real property was never about environments:
   *
   *   two writers on one account = two independent ledgers against one escrow.
   *
   * `akash_tx_allocations_single_writer_idx` is a PER-DATABASE partial unique index, so it
   * serializes claims within one writer's Postgres and can never see another writer's. Two
   * writers therefore double-spend regardless of how many environments each serves. Hence:
   * `account -> writer` INJECTIVE, `writer -> envs` deliberately one-to-many.
   *
   * The bite is unchanged in the direction that matters: add a second writer on an account that
   * already has one and this goes red. What is no longer forbidden is a single writer minting
   * for several environments — which is the whole point.
   */
  it("binds each Console actuator account to at most one WRITER", () => {
    expect(
      duplicates(REAL_BINDINGS.map((binding) => binding.accountId))
    ).toEqual([]);
    for (const binding of REAL_BINDINGS) {
      expect(binding.accountId, `${binding.writerId} pins no account`).not.toBe(
        ""
      );
    }
  });

  /**
   * ONE_CONSOLE_KEY_REMOTEREF_PER_ACCOUNT (bug.5187). The account pin is plain config a human
   * writes; the CREDENTIAL is what actually spends. Two environments whose actuator
   * ExternalSecret pulls the same OpenBao path hold the same Console key and are therefore two
   * writers on one account no matter what their pins claim. This is the north star's explicitly
   * REJECTED shortcut — "put the production Console key into candidate-a or preview" — caught at
   * review time, from git, with no cluster contact.
   *
   * Also asserted: only a writer's own cluster ships an actuator ExternalSecret at all. An
   * environment with the credential but no writer is a credential waiting to become one.
   */
  it("gives each account exactly one environment carrying its Console-key remoteRef", () => {
    expect(
      duplicates(REAL_BINDINGS.map((binding) => binding.secretPath))
    ).toEqual([]);
    for (const binding of REAL_BINDINGS) {
      expect(
        binding.secretPath,
        `${binding.writerId} ships no actuator ExternalSecret`
      ).toBe(`${binding.cluster}/akash-tx-actuator`);
    }

    const writerClusters = new Set(
      CROSSPLANE_ACTUATOR_WRITERS.map((writer) => writer.cluster)
    );
    for (const environment of INSTALLED_ENVS) {
      if (writerClusters.has(environment)) continue;
      expect(
        actuatorSecretPath(environment),
        `${environment} hosts no writer but ships an actuator Console credential`
      ).toBe("");
    }
  });

  /**
   * EVERY_SELECTED_ENV_NAMES_EXACTLY_ONE_WRITER (bug.5187). A catalog row selecting
   * `compute_api: <env>: crossplane` is a workload whose leases someone must mint and pay for.
   * Zero writers is a node that renders a composite nothing will fund; TWO writers claiming the
   * same environment is the ambiguity `writerFor` refuses to resolve, and it is how a second
   * writer would arrive on an account by accident. Asserted over the real catalog, so the guard
   * widens automatically the moment a row moves to the Crossplane authority.
   */
  it("names exactly one writer for every (env, owner) the catalog selects crossplane in", () => {
    expect(CROSSPLANE_SELECTED_PAIRS.length).toBeGreaterThan(0);
    const byPair = writersByServedPair(CROSSPLANE_ACTUATOR_WRITERS);
    for (const { env, owner } of CROSSPLANE_SELECTED_PAIRS) {
      expect(
        byPair.get(`${env}|${owner}`) ?? [],
        `${env} rows owned by ${owner} select crossplane but no single writer mints for them`
      ).toHaveLength(1);
      expect(writerFor(env, owner)?.id, `${env}|${owner}`).toBeDefined();
    }
  });

  /**
   * WRITER_TO_ENVS_IS_ONE_TO_MANY. Stated as an executable fact rather than prose so the next
   * reader cannot mistake today's one-writer-per-env reality for the rule: every environment a
   * writer serves must be a real deploy environment, and a writer with an empty `serves` list is
   * a writer that funds nothing. Nothing here requires `serves` to be a single environment —
   * that is the freedom the north star needs and the previous guard removed.
   */
  it("lets one writer serve many environments, but never zero", () => {
    for (const writer of CROSSPLANE_ACTUATOR_WRITERS) {
      expect(writer.serves.length, writer.id).toBeGreaterThan(0);
      for (const environment of writer.serves) {
        expect(INSTALLED_ENVS, `${writer.id} serves ${environment}`).toContain(
          environment
        );
      }
    }
    expect([...CROSSPLANE_ACTUATOR_WALLET_ENVS].sort()).toEqual(
      [...new Set(CROSSPLANE_ACTUATOR_WRITERS.map((w) => w.cluster))].sort()
    );
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

/**
 * NO_CONSOLE_KEY_SLOT_OUTSIDE_A_WRITER (task.5138, knowledge:akash-actuator-wallet-cutover).
 *
 * The Sep-15 drift this pins down: the guards above police the WRITERS' credentials, but said
 * nothing about a Console credential SLOT living somewhere else entirely. The operator app kept
 * its own `AKASH_CONSOLE_API_KEY` — a catalog entry, an env-schema key, a projected secret —
 * long after the actuator became the only legitimate holder, and when that key was deliberately
 * deleted server-side the app 401'd for days because the slot still existed to fail. One Console
 * account has ONE key, held ONLY by that account's actuator writer. A slot outside a writer is a
 * credential waiting to become a second writer (or, as here, a corpse waiting to 401).
 */
describe("Console credential slots exist only inside a writer (task.5138)", () => {
  /** Matches the retired app slot AND the actuator slot — any Akash Console key name. */
  const CONSOLE_KEY_NAME = /AKASH_[A-Z_]*CONSOLE_API_KEY/;

  it("never re-admits the retired app slot to the secrets catalog", () => {
    const catalog = readYaml(
      path.join(REPO_ROOT, "infra/secrets-catalog.yaml")
    );
    const names = ((catalog.secrets ?? []) as YamlObject[]).map(
      (entry) => entry.name
    );
    // The catalog parsed and is non-trivial — an empty list would make the guard vacuous.
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("AKASH_CONSOLE_API_KEY");
    // The actuator's own slot is the ONE legitimate Console-key catalog entry, and it stays.
    expect(names).toContain("AKASH_ACTUATOR_CONSOLE_API_KEY");
  });

  it("declares no AKASH_CONSOLE_API_KEY key in the app env schema", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "nodes/operator/app/src/shared/env/server-env.ts"),
      "utf8"
    );
    // A SCHEMA DECLARATION, not a substring: the tombstone comment explaining why the key is
    // gone is allowed to (and should) name it.
    expect(source).not.toMatch(/^\s*AKASH_CONSOLE_API_KEY:/m);
  });

  it("lets only a writer's actuator ExternalSecret name an Akash Console key", () => {
    // The one legitimate home per writer — the same per-env leaf `actuatorSecretPath` reads.
    const actuatorFiles = new Set(
      CROSSPLANE_ACTUATOR_WRITERS.map(
        (writer) =>
          `infra/k8s/overlays/${writer.cluster}/operator/akash-tx-actuator-external-secret.yaml`
      )
    );

    const externalSecrets = yamlFiles(
      path.join(REPO_ROOT, "infra/k8s")
    ).flatMap((file) =>
      readYamlDocuments(file)
        .filter((document) => document.kind === "ExternalSecret")
        .map((document) => ({
          file: path.relative(REPO_ROOT, file),
          document,
        }))
    );
    // The enumeration actually found the fleet's ExternalSecrets — zero would mean the walk is
    // broken, not that the repo is clean.
    expect(externalSecrets.length).toBeGreaterThan(0);

    const offenders = externalSecrets
      .filter(
        ({ file, document }) =>
          !actuatorFiles.has(file) &&
          CONSOLE_KEY_NAME.test(JSON.stringify(document))
      )
      .map(
        ({ file, document }) =>
          `${file}: ExternalSecret/${metadataName(document)}`
      );
    expect(offenders).toEqual([]);
  });

  it("BITES: the name pattern catches both the retired and the live slot names", () => {
    expect(CONSOLE_KEY_NAME.test("AKASH_CONSOLE_API_KEY")).toBe(true);
    expect(CONSOLE_KEY_NAME.test("AKASH_ACTUATOR_CONSOLE_API_KEY")).toBe(true);
    expect(CONSOLE_KEY_NAME.test("AKASH_ACTUATOR_ACCOUNT_ID")).toBe(false);
  });
});

/**
 * THE GUARD BITES. Every assertion above reads real repo files, so "it passed" alone proves
 * nothing about whether it CAN fail. These feed the same pure predicates the deliberately-wrong
 * fixtures the guard exists to catch, so falsifiability is proven in-repo and permanently,
 * rather than once by hand in a PR description.
 */
describe("account -> writer injectivity is falsifiable (bug.5187)", () => {
  const CANDIDATE = "candidate-a";
  const PRODUCTION = "production";

  it("catches a SECOND writer on an account that already has one", () => {
    // Two writers, two clusters, but both would resolve to production's pinned account — the
    // double-spend shape. (The candidate-a entry names production's cluster on purpose: the
    // account a writer holds is read from its cluster's overlay.)
    const bindings = writerBindings([
      { id: "a/akash-tx-actuator", cluster: PRODUCTION, serves: [PRODUCTION] },
      { id: "b/akash-tx-actuator", cluster: PRODUCTION, serves: [CANDIDATE] },
    ]);
    expect(duplicates(bindings.map((binding) => binding.accountId))).toEqual([
      actuatorAccountId(PRODUCTION),
    ]);
  });

  it("catches two environments sharing one Console-key remoteRef", () => {
    const bindings = writerBindings([
      { id: "a/akash-tx-actuator", cluster: PRODUCTION, serves: [PRODUCTION] },
      { id: "b/akash-tx-actuator", cluster: PRODUCTION, serves: [CANDIDATE] },
    ]);
    expect(duplicates(bindings.map((binding) => binding.secretPath))).toEqual([
      `${PRODUCTION}/akash-tx-actuator`,
    ]);
  });

  it("catches an environment claimed by TWO writers", () => {
    // Two writers claiming one env FOR THE SAME OWNER is still the violation.
    const byPair = writersByServedPair([
      {
        id: "a/akash-tx-actuator",
        cluster: CANDIDATE,
        serves: [PRODUCTION],
        owners: ["cogni-dao"],
      },
      {
        id: "b/akash-tx-actuator",
        cluster: PRODUCTION,
        serves: [PRODUCTION],
        owners: ["cogni-dao"],
      },
    ]);
    expect(byPair.get(`${PRODUCTION}|cogni-dao`)).toHaveLength(2);
  });

  it("catches a selected environment NO writer serves", () => {
    const byPair = writersByServedPair([
      {
        id: "a/akash-tx-actuator",
        cluster: CANDIDATE,
        serves: [CANDIDATE],
        owners: ["cogni-dao"],
      },
    ]);
    expect(byPair.get(`${PRODUCTION}|cogni-dao`) ?? []).toHaveLength(0);
  });

  it("does NOT flag one writer serving many environments — the north star shape", () => {
    const writers = [
      {
        id: "production/akash-tx-actuator",
        cluster: PRODUCTION,
        serves: [CANDIDATE, "preview", PRODUCTION],
        owners: ["cogni-dao"],
      },
    ];
    const bindings = writerBindings(writers);
    expect(duplicates(bindings.map((binding) => binding.accountId))).toEqual(
      []
    );
    expect(duplicates(bindings.map((binding) => binding.secretPath))).toEqual(
      []
    );
    for (const environment of [CANDIDATE, "preview", PRODUCTION]) {
      expect(
        writersByServedPair(writers).get(`${environment}|cogni-dao`)
      ).toHaveLength(1);
    }
  });
});
