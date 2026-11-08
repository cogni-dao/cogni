// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/env-membership-plan`
 * Purpose: Pin the pure env-delta planner on the node-deploy lane (story.5137, task.5411): an add writes
 *   ONLY the catalog (`deployment_provider: akash` + `compute_api: node-deploy`) and scheduler routing;
 *   a remove drops the env's cells; no AppSet, overlay, ExternalSecret or `lease_generation` is ever
 *   written or deleted.
 * Scope: Pure unit tests over hand-built fixtures (no Octokit).
 * Invariants: ONE_WRITER_PER_NODE_LANE, REMOVE_COMPLETES_THE_ROW, IDEMPOTENT, OPERATOR_SELF_HOSTS_THE_VERB,
 *   K3S_NODE_LANE_RETIRED, REGION_BINDS_ON_THE_NEXT_RELEASE.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/env-membership-plan
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  buildEnvDeltaPlan,
  buildPlacementPlan,
  buildRegionPlan,
  CATALOG_PATH,
  type EnvPlanCurrent,
  EnvPlanError,
  type EnvPlanOp,
  schedulerEndpointPatchPath,
} from "./env-membership-plan";

const SLUG = "blue";
const NODE_ID = "11111111-1111-4111-8111-111111111111";

const catalogWith = (
  envs: readonly string[],
  extra = "",
  sourceRepo = true
): string =>
  `name: ${SLUG}
type: node
port: 3200
node_port: 31100
${sourceRepo ? `source_repo: https://github.com/cogni-dao/${SLUG}.git\n` : ""}candidate_a_branch: deploy/candidate-a-${SLUG}
preview_branch: deploy/preview-${SLUG}
production_branch: deploy/production-${SLUG}
envs: [${envs.join(", ")}]
${extra}activity_env: ${envs[envs.length - 1] ?? "production"}
path_prefix: nodes/${SLUG}/
node_id: ${NODE_ID}
`;

const schedulerPatchFixture = (url: string): string =>
  `apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "${SLUG}=${url},${NODE_ID}=${url}"
  TEMPORAL_CUSTODIED_NODE_ENDPOINTS: "{}"
`;

function current(catalog: string): EnvPlanCurrent {
  const schedulerEndpointPatchByEnv: Record<string, string> = {};
  for (const e of ["candidate-a", "preview", "production"]) {
    schedulerEndpointPatchByEnv[e] = schedulerPatchFixture(
      `http://${SLUG}-node-app:3000`
    );
  }
  return { catalog, schedulerEndpointPatchByEnv };
}

const LEGACY_PATH =
  /infra\/k8s\/(overlays\/[^/]+\/blue\/|argocd\/appsets\/)|external-secret/;
const paths = (ops: readonly EnvPlanOp[]): string[] => ops.map((o) => o.path);
const catalogOf = (ops: readonly EnvPlanOp[]): string => {
  const op = ops.find((o) => o.path === CATALOG_PATH(SLUG));
  if (!op || op.op !== "upsert") throw new Error("no catalog upsert");
  return op.content;
};

describe("buildEnvDeltaPlan — ADD (node-deploy lane)", () => {
  const prodOnly = catalogWith(
    ["production"],
    "deployment_provider:\n  production: akash\ncompute_api:\n  production: node-deploy\n"
  );

  it("writes only the catalog cells + scheduler routing; no AppSet/overlay/ExternalSecret", () => {
    const res = buildEnvDeltaPlan({
      slug: SLUG,
      env: "candidate-a",
      present: true,
      current: current(prodOnly),
    });
    if (res.kind !== "add") throw new Error(`unexpected ${res.kind}`);
    expect(res.nextEnvs).toEqual(["candidate-a", "production"]);
    expect(res.ops.every((o) => o.op === "upsert")).toBe(true);
    expect(paths(res.ops).filter((p) => LEGACY_PATH.test(p))).toEqual([]);
    expect(paths(res.ops)).toContain(CATALOG_PATH(SLUG));
    expect(paths(res.ops)).toContain(schedulerEndpointPatchPath("candidate-a"));
    const catalog = catalogOf(res.ops);
    expect(catalog).toMatch(/^envs: \[candidate-a, production\]$/m);
    expect(catalog).toContain(
      "deployment_provider:\n  candidate-a: akash\n  production: akash\n"
    );
    expect(catalog).toContain(
      "compute_api:\n  candidate-a: node-deploy\n  production: node-deploy\n"
    );
    expect(catalog).not.toContain("lease_generation");
    expect(catalog).not.toContain("crossplane");
  });

  it("is idempotent for an env already present", () => {
    expect(
      buildEnvDeltaPlan({
        slug: SLUG,
        env: "production",
        present: true,
        current: current(prodOnly),
      })
    ).toEqual({ kind: "no_changes" });
  });

  it("refuses an add for an in-repo row (no source_repo, no node-deploy lane)", () => {
    expect(() =>
      buildEnvDeltaPlan({
        slug: SLUG,
        env: "candidate-a",
        present: true,
        current: current(catalogWith(["production"], "", false)),
      })
    ).toThrow(EnvPlanError);
  });
});

describe("buildEnvDeltaPlan — REMOVE", () => {
  const both = catalogWith(
    ["candidate-a", "production"],
    "deployment_provider:\n  candidate-a: akash\n  production: akash\ncompute_api:\n  candidate-a: node-deploy\n  production: node-deploy\nrequired_placement_countries:\n  candidate-a: [PT]\n"
  );

  it("drops the env and every placement cell for it; deletes no file", () => {
    const res = buildEnvDeltaPlan({
      slug: SLUG,
      env: "candidate-a",
      present: false,
      current: current(both),
    });
    if (res.kind !== "remove") throw new Error(`unexpected ${res.kind}`);
    expect(res.nextEnvs).toEqual(["production"]);
    expect(res.ops.filter((o) => o.op === "delete")).toEqual([]);
    const catalog = catalogOf(res.ops);
    expect(catalog).toMatch(/^envs: \[production\]$/m);
    expect(catalog).toContain("deployment_provider:\n  production: akash\n");
    expect(catalog).toContain("compute_api:\n  production: node-deploy\n");
    expect(catalog).not.toContain("required_placement_countries");
  });

  it("rejects removing the activity authority and refuses the operator", () => {
    expect(() =>
      buildEnvDeltaPlan({
        slug: SLUG,
        env: "production",
        present: false,
        current: current(both),
      })
    ).toThrow(EnvPlanError);
    expect(() =>
      buildEnvDeltaPlan({
        slug: "operator",
        env: "production",
        present: false,
        current: current(both),
      })
    ).toThrow(/control plane/);
  });
});

describe("buildPlacementPlan", () => {
  it("refuses k3s for an externally built node (K3S_NODE_LANE_RETIRED)", () => {
    expect(() =>
      buildPlacementPlan({
        slug: SLUG,
        env: "production",
        placement: "k3s",
        current: current(catalogWith(["production"])),
      })
    ).toThrow(/k3s/);
  });
});

describe("buildRegionPlan — no lease_generation", () => {
  it("writes only the required_placement_countries cell", () => {
    const res = buildRegionPlan({
      slug: SLUG,
      env: "production",
      countries: ["PT", "NL"],
      current: current(
        catalogWith(
          ["production"],
          "deployment_provider:\n  production: akash\ncompute_api:\n  production: node-deploy\n"
        )
      ),
    });
    if (res.kind !== "set_region") throw new Error(`unexpected ${res.kind}`);
    const catalog = catalogOf(res.ops);
    expect(catalog).toContain(
      "required_placement_countries:\n  production: [NL, PT]\n"
    );
    expect(catalog).not.toContain("lease_generation");
  });
});
