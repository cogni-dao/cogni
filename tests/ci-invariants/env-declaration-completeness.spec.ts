// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/env-declaration-completeness`
 * Purpose: Enforces NO_SILENT_DEFAULT (story.5040, ci-cd.md Axiom 23) — declaring an env for a node is an all-or-nothing act. A declared env whose placement cells or rendered artifacts are absent renders the deprecated k3s lane, or nothing at all, while every gate stays green.
 * Scope: Static structural read of infra/catalog + the artifacts it implies; does not shell out, build, render, or hit the network, and does not assert artifact CONTENT.
 * Invariants:
 *   PLACEMENT_IS_COMPLETE_PER_ENV: a placed node declares provider + `compute_api: node-deploy` per env (story.5137).
 *   NO_PLACEMENT_FOR_UNDECLARED_ENV: a placement cell may not name an env outside `envs:`.
 *   DECLARED_ENV_HAS_APPSET: each (node, env) has an AppSet under its reconciling cluster's dir, except a `compute_api: node-deploy` cell, which must have none (story.5137).
 *   DECLARED_ENV_HAS_OVERLAY: each in-repo (node, env) has a populated Kustomize overlay dir; a `node-deploy` cell has none.
 * Side-effects: IO (reads infra/catalog, infra/k8s/argocd/appsets, infra/k8s/overlays)
 * Links: docs/spec/ci-cd.md Axiom 23, story.5040, task.5132, bug.5204
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CATALOG_DIR = path.join(REPO_ROOT, "infra/catalog");
const APPSETS_DIR = path.join(REPO_ROOT, "infra/k8s/argocd/appsets");
const OVERLAYS_DIR = path.join(REPO_ROOT, "infra/k8s/overlays");
const FLEET_CONTROL_ENV = process.env.FLEET_CONTROL_ENV || "production";

interface CatalogEntry {
  name: string;
  type?: string;
  /** Present ⇒ the node app lives in its OWN repo and is placed off-cluster. */
  source_repo?: unknown;
  envs?: string[];
  deployment_provider?: Record<string, string>;
  compute_api?: Record<string, string>;
}

function nodeRows(): CatalogEntry[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map(
      (f) =>
        yaml.parse(
          readFileSync(path.join(CATALOG_DIR, f), "utf8")
        ) as CatalogEntry
    )
    .filter((e) => e?.type === "node" && Array.isArray(e.envs));
}

/**
 * WHICH CLUSTER reconciles this (env, node) — the same rule as
 * scripts/ci/render-node-appset.sh (task.5132). A node app runs on Akash, so its XR is pure
 * desired state and the PAYING cluster holds it; k3s rows stay with their own env's Argo.
 */
function reconcilingCluster(env: string, provider: string | undefined): string {
  if (env === FLEET_CONTROL_ENV) return FLEET_CONTROL_ENV;
  return provider === "akash" ? FLEET_CONTROL_ENV : env;
}

const ROWS = nodeRows();

describe("env declaration completeness (NO_SILENT_DEFAULT, story.5040)", () => {
  it("has node rows to check", () => {
    expect(ROWS.length).toBeGreaterThan(0);
  });

  describe.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const envs = row.envs ?? [];

    /**
     * Scoped by DATA, never by a name list (the hardcoded-roster antipattern this file exists to
     * kill). `source_repo` present ⇒ the node app lives in its own repo and is PLACED — it must
     * say where. The in-repo control plane has no `source_repo` and is not placed off-cluster,
     * so it has nothing to declare and is not silently defaulting.
     */
    const isPlacedNode = Boolean(row.source_repo);

    it.each(
      isPlacedNode ? envs : []
    )("PLACEMENT_IS_COMPLETE_PER_ENV: %s declares provider + compute_api node-deploy", (env) => {
      const provider = row.deployment_provider?.[env];
      expect(
        provider,
        `${row.name} declares env '${env}' but has no deployment_provider.${env}. ` +
          `Absent placement is a HARD FAILURE, not a k3s fallback (ci-cd.md Axiom 23).`
      ).toBeTruthy();

      expect(
        row.compute_api?.[env],
        `${row.name}.${env} has no compute_api.${env}: node-deploy. The deploy verb is the only ` +
          `node lane writer (ONE_WRITER_PER_NODE_LANE, story.5137).`
      ).toBe("node-deploy");
    });

    it("NO_PLACEMENT_FOR_UNDECLARED_ENV: no placement cell outside envs:", () => {
      for (const block of ["deployment_provider", "compute_api"] as const) {
        for (const env of Object.keys(row[block] ?? {})) {
          expect(
            envs,
            `${row.name}.${block}.${env} names an env not in envs: — authority pointed at a ` +
              `workload that does not exist.`
          ).toContain(env);
        }
      }
    });

    it.each(envs)("DECLARED_ENV_HAS_APPSET: %s", (env) => {
      const cluster = reconcilingCluster(env, row.deployment_provider?.[env]);
      const appset = path.join(
        APPSETS_DIR,
        cluster,
        `${env}-${row.name}-applicationset.yaml`
      );
      // ONE_WRITER_PER_NODE_LANE (story.5137): a `node-deploy` cell is written only by the deploy
      // verb, so it must have NO AppSet (Argo would otherwise keep a second writer on its lane).
      const verbOwned = row.compute_api?.[env] === "node-deploy";
      expect(
        existsSync(appset),
        verbOwned
          ? `${row.name}.${env} is compute_api=node-deploy but ${path.relative(REPO_ROOT, appset)} exists. ` +
              `Run \`pnpm gen:node-appset\`; the verb is the lane's only writer (CD4).`
          : `${row.name} declares env '${env}' but ${path.relative(REPO_ROOT, appset)} is absent. ` +
              `Run \`pnpm gen:node-appset\`. An env with no AppSet is never reconciled and never ` +
              `reports a failure (bug.5204).`
      ).toBe(!verbOwned);
    });

    it.each(envs)("DECLARED_ENV_HAS_OVERLAY: %s", (env) => {
      const overlay = path.join(OVERLAYS_DIR, env, row.name);
      const populated =
        existsSync(overlay) &&
        readdirSync(overlay).some((f) => f.endsWith(".yaml"));
      // A `node-deploy` cell is rendered by the deploy verb, never by a Kustomize overlay.
      const verbOwned = row.compute_api?.[env] === "node-deploy";
      expect(
        populated,
        verbOwned
          ? `${row.name}.${env} is compute_api=node-deploy but ${path.relative(REPO_ROOT, overlay)} ` +
              `exists. The verb is the lane's only writer (CD4); delete the overlay.`
          : `${row.name} declares env '${env}' but ${path.relative(REPO_ROOT, overlay)} is missing ` +
              `or empty. Argo syncs nothing while every check stays green.`
      ).toBe(!verbOwned);
    });
  });
});
