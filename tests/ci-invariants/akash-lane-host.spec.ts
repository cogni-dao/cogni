// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/akash-lane-host`
 * Purpose: Pins RECONCILIATION_FOLLOWS_PAYMENT (story.5016 seam 3) — the committed AppSet layout
 *   and `@shared/node-registry/akash-lane-host` must be the SAME map, in both directions. An
 *   akash+crossplane pre-prod lane is reconciled by the PRODUCTION cluster (its AppSet lives in
 *   `appsets/production-hosted-lanes/`, applied by `cogni-production-hosted-lane-appsets`);
 *   everything else is reconciled by its own environment, byte-identically to before.
 * Scope: Static reads of the catalog, the appsets tree and the control-plane tree. Does NOT contact a cluster, a provider or an Akash account.
 *   Paths: `infra/catalog/*.yaml`, `infra/k8s/argocd/appsets/**`, `infra/k8s/argocd/control-plane/**`.
 * Invariants: ONE_CLUSTER_PER_CELL, K3S_IS_UNTOUCHED, PRODUCTION_DELIVERY_IS_UNCHANGED,
 *   ONLY_DELIVERY_MOVED, CUSTODY_FLOWS_DOWN_TRUST.
 * Side-effects: IO (reads repo manifests)
 * Links: src/shared/node-registry/akash-lane-host.ts, scripts/ci/render-node-appset.sh,
 *   infra/k8s/argocd/control-plane/production/production-hosted-lane-appsets-application.yaml,
 *   infra/k8s/overlays/production/akash-lanes/ (seam 4), knowledge:akash-actuator-wallet-cutover,
 *   story.5016
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AKASH_LANE_HOST_ENV,
  appsetsDirForLane,
  HOSTED_LANE_APPSETS_DIR,
} from "@/shared/node-registry/akash-lane-host";
import {
  CROSSPLANE_ACTUATOR_WRITERS,
  writerFor,
} from "@/shared/node-registry/crossplane-control-plane";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CATALOG_DIR = path.join(REPO_ROOT, "infra/catalog");
const APPSETS_ROOT = path.join(REPO_ROOT, "infra/k8s/argocd/appsets");
const CONTROL_PLANE_ROOT = path.join(
  REPO_ROOT,
  "infra/k8s/argocd/control-plane"
);
const HOSTED_LANE_APPLICATION = path.join(
  CONTROL_PLANE_ROOT,
  "production/production-hosted-lane-appsets-application.yaml"
);

/** The environments the renderer emits cells for — `ENVS` in `render-node-appset.sh`. */
const ENVS = ["candidate-a", "preview", "production"] as const;

type YamlObject = Record<string, unknown>;

function readYaml(file: string): YamlObject {
  return parse(readFileSync(file, "utf8")) as YamlObject;
}

interface CatalogRow {
  readonly slug: string;
  readonly row: YamlObject;
}

/**
 * Deployable rows — those with a `candidate_a_branch`, the same node-set SSOT the shell renderer
 * uses. `type: infra` rows live on the VM/Compose tier and never get an AppSet.
 */
const DEPLOYABLE_ROWS: CatalogRow[] = readdirSync(CATALOG_DIR)
  .filter((name) => name.endsWith(".yaml") && name !== "_schema.json")
  .sort()
  .map((name) => ({
    slug: name.replace(/\.yaml$/, ""),
    row: readYaml(path.join(CATALOG_DIR, name)),
  }))
  .filter(
    ({ row }) =>
      typeof row.candidate_a_branch === "string" &&
      row.candidate_a_branch !== ""
  );

interface Cell {
  readonly env: string;
  readonly slug: string;
  /** The appsets directory the typed resolver says must own this cell. */
  readonly dir: string;
  readonly file: string;
}

/** Every `(env, node)` cell the catalog declares, with its resolved reconciling directory. */
const CELLS: Cell[] = DEPLOYABLE_ROWS.flatMap(({ slug, row }) => {
  const envs = Array.isArray(row.envs) ? (row.envs as string[]) : [];
  return ENVS.filter((env) => envs.includes(env)).map((env) => {
    const providerMap = (row.deployment_provider ?? {}) as Record<
      string,
      string
    >;
    const authorityMap = (row.compute_api ?? {}) as Record<string, string>;
    return {
      env,
      slug,
      dir: appsetsDirForLane({
        environment: env,
        deploymentProvider: providerMap[env] === "akash" ? "akash" : "k3s",
        computeApi:
          authorityMap[env] === "crossplane" ? "crossplane" : "legacy",
      }),
      file: `${env}-${slug}-applicationset.yaml`,
    };
  });
});

/** Every committed AppSet file, as `<dir>/<file>`. */
const COMMITTED: { readonly dir: string; readonly file: string }[] =
  readdirSync(APPSETS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(APPSETS_ROOT, entry.name))
        .filter((file) => file.endsWith("-applicationset.yaml"))
        .map((file) => ({ dir: entry.name, file }))
    )
    .sort((a, b) => `${a.dir}/${a.file}`.localeCompare(`${b.dir}/${b.file}`));

describe("Akash lane host — which cluster reconciles which cell (story.5016 seam 3)", () => {
  /**
   * ONE_CLUSTER_PER_CELL, forward direction. Every catalog cell has its AppSet in EXACTLY the
   * directory the typed resolver names, and in no other directory. A file present in two
   * directories would be two app-of-apps applying one ApplicationSet into two clusters — two
   * Crossplane instances reconciling one XR, two writers minting against one Console account under
   * the same idempotence key. That is the double-spend the whole design exists to prevent, so it is
   * asserted structurally rather than left to the renderer being correct.
   */
  it("places every catalog cell in exactly the directory the resolver names", () => {
    for (const cell of CELLS) {
      const expected = path.join(APPSETS_ROOT, cell.dir, cell.file);
      expect(
        existsSync(expected),
        `${cell.env}/${cell.slug}: expected AppSet at appsets/${cell.dir}/${cell.file}`
      ).toBe(true);

      const elsewhere = COMMITTED.filter(
        (entry) => entry.file === cell.file && entry.dir !== cell.dir
      );
      expect(
        elsewhere.map((entry) => `appsets/${entry.dir}/${entry.file}`),
        `${cell.env}/${cell.slug}: the same AppSet is committed under a second directory — two clusters would reconcile one XR`
      ).toEqual([]);
    }
  });

  /**
   * ONE_CLUSTER_PER_CELL, reverse direction. No committed AppSet may exist without a catalog cell
   * that resolves to its directory. Catches a stale file left behind by a hand edit, and — the
   * reason this half matters — a cell that was REHOMED without its old copy being deleted.
   */
  it("commits no AppSet that no catalog cell resolves to", () => {
    const declared = new Set(CELLS.map((cell) => `${cell.dir}/${cell.file}`));
    const orphans = COMMITTED.map(
      (entry) => `${entry.dir}/${entry.file}`
    ).filter((key) => !declared.has(key));
    expect(
      orphans,
      "committed AppSets with no catalog cell resolving there"
    ).toEqual([]);
  });

  /**
   * The hosted-lane directory holds ONLY what its name claims: non-production cells that are both
   * akash-placed and crossplane-owned. K3S_IS_UNTOUCHED is the other half of this — a k3s row can
   * never end up here, so the non-Akash lane is provably unaffected by seam 3.
   */
  it("hosts only non-production akash+crossplane cells", () => {
    const hosted = CELLS.filter((cell) => cell.dir === HOSTED_LANE_APPSETS_DIR);
    for (const cell of hosted) {
      const row = DEPLOYABLE_ROWS.find(
        (entry) => entry.slug === cell.slug
      )?.row;
      const providerMap = (row?.deployment_provider ?? {}) as Record<
        string,
        string
      >;
      const authorityMap = (row?.compute_api ?? {}) as Record<string, string>;
      expect(
        cell.env,
        `${cell.slug}: production is never hosted by itself`
      ).not.toBe("production");
      expect(providerMap[cell.env], `${cell.env}/${cell.slug}`).toBe("akash");
      expect(authorityMap[cell.env], `${cell.env}/${cell.slug}`).toBe(
        "crossplane"
      );
    }
    // Reverse: a committed file in the hosted dir must correspond to a hosted cell.
    const hostedFiles = new Set(hosted.map((cell) => cell.file));
    expect(
      COMMITTED.filter((entry) => entry.dir === HOSTED_LANE_APPSETS_DIR)
        .map((entry) => entry.file)
        .filter((file) => !hostedFiles.has(file))
    ).toEqual([]);
  });

  /**
   * PRODUCTION_DELIVERY_IS_UNCHANGED. Nothing seam 3 does may add a foreign env's AppSet to
   * `appsets/production/` — that directory's app-of-apps documents, in its own header, that it
   * "can never fan a foreign env's AppSets onto the production cluster". The hosted lanes are a
   * deliberate exception with their OWN Application, which is what keeps that sentence true.
   */
  it("keeps appsets/production/ free of foreign-env AppSets", () => {
    const foreign = COMMITTED.filter(
      (entry) =>
        entry.dir === "production" && !entry.file.startsWith("production-")
    );
    expect(foreign.map((entry) => entry.file)).toEqual([]);
  });

  /**
   * ONLY_DELIVERY_MOVED. A hosted lane's AppSet still generates from its OWN deploy branch, still
   * sources its OWN overlay path, and still targets the `cogni-<env>` namespace. Those three are
   * what make the rendered XR satisfy the Composition's two identity gates
   * (`metadata.name == spec.nodeId`, `cogni-<spec.environment> == metadata.namespace`) unchanged —
   * which is precisely why no Composition edit is needed. If a future edit "helpfully" rewrote the
   * namespace to `cogni-production`, the gate would reject the XR and the lane would silently stop
   * reconciling; this catches that at review time.
   */
  it("leaves a hosted lane's branch, path and namespace on its own environment", () => {
    for (const cell of CELLS.filter(
      (entry) => entry.dir === HOSTED_LANE_APPSETS_DIR
    )) {
      const appset = readYaml(path.join(APPSETS_ROOT, cell.dir, cell.file));
      const spec = appset.spec as YamlObject;
      const generator = ((spec.generators as YamlObject[])[0] as YamlObject)
        .git as YamlObject;
      const template = (spec.template as YamlObject).spec as YamlObject;
      const source = template.source as YamlObject;
      const destination = template.destination as YamlObject;

      expect(generator.revision, `${cell.file}: generator revision`).toBe(
        `deploy/${cell.env}-${cell.slug}`
      );
      expect(source.targetRevision, `${cell.file}: source targetRevision`).toBe(
        `deploy/${cell.env}-{{.name}}`
      );
      expect(source.path, `${cell.file}: overlay path`).toBe(
        `infra/k8s/overlays/${cell.env}/{{.name}}`
      );
      expect(destination.namespace, `${cell.file}: destination namespace`).toBe(
        `cogni-${cell.env}`
      );
      // In-cluster: the AppSet is installed in the production cluster, so this IS production.
      // A registered remote cluster here would be the up-trust shape the north star rejects.
      expect(destination.server, `${cell.file}: destination server`).toBe(
        "https://kubernetes.default.svc"
      );
    }
  });

  /**
   * CUSTODY_FLOWS_DOWN_TRUST. The Application that applies the hosted lanes lives in
   * `control-plane/production/` and NOWHERE else, so only the production root app-of-apps
   * reconciles it. A copy under `control-plane/candidate-a/` or `control-plane/preview/` would fan
   * every hosted lane onto a cluster that runs unmerged control-plane trees — the inverse,
   * forbidden direction.
   */
  it("registers the hosted-lane Application only in production's control plane", () => {
    expect(existsSync(HOSTED_LANE_APPLICATION)).toBe(true);
    for (const env of ENVS.filter((candidate) => candidate !== "production")) {
      const dir = path.join(CONTROL_PLANE_ROOT, env);
      const sourcesHostedLanes = readdirSync(dir)
        .filter((file) => /\.ya?ml$/.test(file))
        .filter((file) =>
          readFileSync(path.join(dir, file), "utf8").includes(
            `appsets/${HOSTED_LANE_APPSETS_DIR}`
          )
        );
      expect(
        sourcesHostedLanes,
        `${env} control plane must not source the production-hosted lanes`
      ).toEqual([]);
    }
  });

  /**
   * The hosted-lane Application's own shape. `prune: true` is load-bearing and DELIBERATELY unlike
   * the seam-4 lanes Application next door: there, pruning would delete a lane NAMESPACE and
   * cascade-delete live XComputeWorkloads without draining them, orphaning a paid lease. Here it is
   * the opposite — a cell that leaves the catalog must take its Application and XR with it so the
   * XR's finalizer CLOSES the lease. `targetRevision: main` keeps production off unmerged
   * control-plane trees.
   */
  it("applies the hosted lanes from main, in-cluster, with prune and selfHeal", () => {
    const application = readYaml(HOSTED_LANE_APPLICATION);
    const spec = application.spec as YamlObject;
    const source = spec.source as YamlObject;
    const destination = spec.destination as YamlObject;
    const syncPolicy = spec.syncPolicy as YamlObject;

    expect(application.kind).toBe("Application");
    expect((application.metadata as YamlObject).name).toBe(
      "cogni-production-hosted-lane-appsets"
    );
    expect(source.targetRevision).toBe("main");
    expect(source.path).toBe(
      `infra/k8s/argocd/appsets/${HOSTED_LANE_APPSETS_DIR}`
    );
    expect(destination.server).toBe("https://kubernetes.default.svc");
    expect(destination.namespace).toBe("argocd");
    expect(syncPolicy.automated).toEqual({ prune: true, selfHeal: true });
  });

  /**
   * DELIVERY_AGREES_WITH_PAYMENT (bug.5187 + seam 3). These are two reviewed maps that answer two
   * different questions — `CROSSPLANE_ACTUATOR_WRITERS[].serves` says which writer PAYS for an
   * environment's leases, `appsetsDirForLane` says which cluster RECONCILES its XR — and they may
   * never disagree. The Composition dials the writer at `akash-tx-actuator.<ns>.svc.cluster.local`
   * and that writer is ClusterIP-private, so a cell delivered to a cluster whose writer does not
   * serve it can only fail; a cell PAID for by a writer in a cluster that does not reconcile it is
   * unreachable in the other direction. Asserting the join here is what makes the first hosted
   * lane a single coherent change: its catalog cell AND the production writer's `serves` list must
   * land together, or CI is red.
   *
   * Vacuous today by construction — every akash row is production-only — which is exactly why the
   * assertion is cheap now and load-bearing at the cutover.
   */
  it("routes a cell to the production cluster only if the production writer serves it", () => {
    const productionWriter = CROSSPLANE_ACTUATOR_WRITERS.find(
      (writer) => writer.cluster === AKASH_LANE_HOST_ENV
    );
    expect(
      productionWriter,
      `${AKASH_LANE_HOST_ENV} must run an actuator writer to host any lane`
    ).toBeDefined();

    for (const cell of CELLS.filter(
      (entry) => entry.dir === HOSTED_LANE_APPSETS_DIR
    )) {
      expect(
        productionWriter?.serves,
        `${cell.env}/${cell.slug} is delivered to the ${AKASH_LANE_HOST_ENV} cluster, so the ${AKASH_LANE_HOST_ENV} writer must serve '${cell.env}' — widen its 'serves' list in CROSSPLANE_ACTUATOR_WRITERS`
      ).toContain(cell.env);
      // ...and it must be the ONLY writer that serves it, or `writerFor` refuses to resolve and
      // two writers are reaching one account.
      expect(writerFor(cell.env)?.cluster, `${cell.env}`).toBe(
        AKASH_LANE_HOST_ENV
      );
    }
  });

  /**
   * The hosted-lane directory is renderer-owned like every other appsets directory: it always
   * carries a kustomization, even while empty. Without it the Application's source path fails to
   * build and the app reports an error rather than "nothing to do" — and the empty state is the
   * state this PR ships in, since every fleet row is production-only today.
   */
  it("always carries a kustomization for the hosted-lane directory", () => {
    const kustomization = path.join(
      APPSETS_ROOT,
      HOSTED_LANE_APPSETS_DIR,
      "kustomization.yaml"
    );
    expect(existsSync(kustomization)).toBe(true);
    const parsed = readYaml(kustomization);
    expect(parsed.kind).toBe("Kustomization");
    const resources = (parsed.resources ?? []) as string[];
    expect([...resources].sort()).toEqual(
      CELLS.filter((cell) => cell.dir === HOSTED_LANE_APPSETS_DIR)
        .map((cell) => cell.file)
        .sort()
    );
  });
});
