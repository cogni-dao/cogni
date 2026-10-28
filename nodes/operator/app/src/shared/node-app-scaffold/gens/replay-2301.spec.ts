// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/replay-2301`
 * Purpose: THE acceptance test for the env verb's full activation artifact set (story.5039,
 *   bug.5204) — replay PR #2301 (task.5132, commit f77d578dd7), the hand-written commit that gave
 *   poly candidate-a AND preview on the production account, through `buildEnvDeltaPlan`
 *   (present:true) and require the SAME tree: two AppSets under appsets/production/, the production
 *   kustomization, two overlay kustomizations, two external-secrets, two scheduler patches, plus
 *   the three catalog placement cells.
 * Scope: Pure replay over checked-in fixtures (`__fixtures__/replay-2301/{pre,expected}/`, SHAs
 *   pinned in its README). Drives the planner twice — candidate-a over the pre state, then preview
 *   over the COMPOSED output — exactly #2301's one-commit-two-envs shape.
 * Invariants: the 9 rendered files are BYTE-EQUAL to expected/; the catalog is STRUCTURALLY equal
 *   (catalog comments are human narrative; the 9 rendered files are byte-law). The current
 *   custody contract additionally writes the production scheduler map without changing its own lane.
 * Side-effects: none (fs reads of checked-in fixtures only)
 * Links: src/shared/node-app-scaffold/gens/env-membership-plan.ts, scripts/ci/lib/appset-paths.sh,
 *   story.5039, task.5132, bug.5204
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { buildEnvDeltaPlan, type EnvPlanCurrent } from "./env-membership-plan";
import type { NodeFormationEnv } from "./envs";

const FIXTURES = path.resolve(__dirname, "__fixtures__/replay-2301");

const read = (side: "pre" | "expected", rel: string): string =>
  readFileSync(path.join(FIXTURES, side, rel), "utf8");

const CATALOG = "infra/catalog/poly.yaml";
const PRODUCTION_KUSTOMIZATION =
  "infra/k8s/argocd/appsets/production/kustomization.yaml";
const APPSET_TEMPLATE = "scripts/ci/node-applicationset.yaml.tmpl";
const schedulerPatch = (env: string): string =>
  `infra/k8s/overlays/${env}/scheduler-worker/node-endpoints.patch.yaml`;

/** The 9 rendered files #2301 wrote (catalog excluded — asserted structurally below). */
const RENDERED_FILES = [
  "infra/k8s/argocd/appsets/production/candidate-a-poly-applicationset.yaml",
  "infra/k8s/argocd/appsets/production/preview-poly-applicationset.yaml",
  PRODUCTION_KUSTOMIZATION,
  "infra/k8s/overlays/candidate-a/poly/kustomization.yaml",
  "infra/k8s/overlays/candidate-a/poly/external-secret.yaml",
  "infra/k8s/overlays/preview/poly/kustomization.yaml",
  "infra/k8s/overlays/preview/poly/external-secret.yaml",
  schedulerPatch("candidate-a"),
  schedulerPatch("preview"),
] as const;

/** Ports read off the fixture catalog itself, exactly like the adapter's parseCatalogPorts. */
function catalogPorts(catalog: string): { port: number; nodePort: number } {
  const port = Number(/^port:\s*(\d+)\s*$/m.exec(catalog)?.[1]);
  const nodePort = Number(/^node_port:\s*(\d+)\s*$/m.exec(catalog)?.[1]);
  if (!Number.isFinite(port) || !Number.isFinite(nodePort)) {
    throw new Error("fixture catalog is missing port/node_port");
  }
  return { port, nodePort };
}

/**
 * Mirror `collectEnvPlanCurrent`'s ADD inputs over an in-memory tree: the WORKLOAD env's
 * node-template overlay + external-secret + scheduler patch, and the CONTROL env's (production —
 * poly is akash) appsets kustomization and scheduler patch.
 */
function currentFor(
  tree: Map<string, string>,
  env: NodeFormationEnv
): EnvPlanCurrent {
  const catalog = tree.get(CATALOG);
  const kustomization = tree.get(PRODUCTION_KUSTOMIZATION);
  const template = tree.get(APPSET_TEMPLATE);
  const patch = tree.get(schedulerPatch(env));
  const controlPatch = tree.get(schedulerPatch("production"));
  if (!catalog || !kustomization || !template || !patch || !controlPatch) {
    throw new Error("replay tree is missing a plan input");
  }
  return {
    catalog,
    templateOverlayByEnv: {
      [env]: read(
        "pre",
        `infra/k8s/overlays/${env}/node-template/kustomization.yaml`
      ),
    },
    templateExternalSecretByEnv: {
      [env]: read(
        "pre",
        `infra/k8s/overlays/${env}/node-template/external-secret.yaml`
      ),
    },
    appsetTemplate: template,
    appsetRepoUrl: "https://github.com/cogni-dao/cogni.git",
    appsetsKustomizationByEnv: { production: kustomization },
    ...catalogPorts(catalog),
    schedulerEndpointPatchByEnv: { [env]: patch, production: controlPatch },
  };
}

function planEnv(tree: Map<string, string>, env: NodeFormationEnv): void {
  const res = buildEnvDeltaPlan({
    slug: "poly",
    env,
    present: true,
    current: currentFor(tree, env),
  });
  expect(res.kind).toBe("add");
  if (res.kind === "no_changes") throw new Error("unexpected no_changes");
  for (const op of res.ops) {
    if (op.op !== "upsert") throw new Error(`unexpected delete: ${op.path}`);
    tree.set(op.path, op.content);
  }
}

describe("replay of PR #2301 — poly candidate-a + preview activation (story.5039)", () => {
  // One composed tree, two sequential adds — the one-commit-two-envs shape of #2301: the preview
  // add plans over the catalog + production kustomization the candidate-a add just wrote.
  const tree = new Map<string, string>([
    [CATALOG, read("pre", CATALOG)],
    [PRODUCTION_KUSTOMIZATION, read("pre", PRODUCTION_KUSTOMIZATION)],
    [APPSET_TEMPLATE, read("pre", APPSET_TEMPLATE)],
    [schedulerPatch("candidate-a"), read("pre", schedulerPatch("candidate-a"))],
    [schedulerPatch("preview"), read("pre", schedulerPatch("preview"))],
    [schedulerPatch("production"), read("pre", schedulerPatch("production"))],
  ]);
  planEnv(tree, "candidate-a");
  planEnv(tree, "preview");

  it.each(RENDERED_FILES)("renders %s byte-equal to #2301", (rel) => {
    expect(tree.get(rel)).toBe(read("expected", rel));
  });

  it("writes the catalog structurally equal to #2301 (comments are human narrative, not byte-law)", () => {
    // #2301's catalog carries a hand-written task.5132 narrative comment the verb cannot author;
    // the machine-readable cells are the contract. The 9 rendered files above are byte-law.
    const rendered = parseYaml(tree.get(CATALOG) ?? "") as Record<
      string,
      unknown
    >;
    const expected = parseYaml(read("expected", CATALOG)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "envs",
      "deployment_provider",
      "compute_api",
      "lease_generation",
      "activity_env",
    ] as const) {
      expect(rendered[key], `catalog key '${key}'`).toEqual(expected[key]);
    }
  });

  it("adds both custody namespaces while preserving production lane endpoints", () => {
    const control = parseYaml(
      tree.get(schedulerPatch("production")) ?? ""
    ).data;
    const original = parseYaml(read("pre", schedulerPatch("production"))).data;
    expect(control.COGNI_NODE_ENDPOINTS).toBe(original.COGNI_NODE_ENDPOINTS);
    expect(JSON.parse(control.TEMPORAL_CUSTODIED_NODE_ENDPOINTS)).toEqual({
      "cogni-candidate-a":
        "poly=https://poly-test.cognidao.org,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly-test.cognidao.org",
      "cogni-preview":
        "poly=https://poly-preview.cognidao.org,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly-preview.cognidao.org",
    });
  });

  it("emits only the historical artifacts plus the control scheduler patch", () => {
    const expectedPaths = new Set<string>([
      CATALOG,
      APPSET_TEMPLATE,
      ...RENDERED_FILES,
      schedulerPatch("production"),
    ]);
    expect([...tree.keys()].sort()).toEqual([...expectedPaths].sort());
  });
});
