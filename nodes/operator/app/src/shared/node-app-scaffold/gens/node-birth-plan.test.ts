// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { nodeBirthPathPlan } from "./node-birth-plan";

describe("nodeBirthPathPlan", () => {
  it("names all thirteen exactly replayable declarative paths but keeps eligibility empty", () => {
    const plan = nodeBirthPathPlan({
      slug: "atlas",
      controlEnvFor: () => "production",
    });

    expect(plan.replayableDeclarative).toEqual(
      plan.current.filter(
        (path) =>
          path !==
          "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts"
      )
    );
    expect(plan.replayableDeclarative).toHaveLength(13);
    expect(plan.replayableDeclarative).toContain(
      "infra/k8s/argocd/appsets/production/kustomization.yaml"
    );
    expect(plan.replayableDeclarative).toContain(
      "infra/compose/edge/configs/Caddyfile.tmpl"
    );
    expect(plan.replayableDeclarative).toContain(
      "infra/k8s/base/scheduler-worker/configmap.yaml"
    );
    expect(plan.eligible).toEqual([]);
    expect(plan.blockers).toEqual([
      "compiled network-nodes.data.ts runtime source is excluded from node birth",
    ]);
  });

  it("inventories every current shared projection", () => {
    const plan = nodeBirthPathPlan({
      slug: "spawny-boi",
      controlEnvFor: () => "production",
    });

    expect(plan.current).toEqual(
      [
        "infra/catalog/spawny-boi.yaml",
        "infra/compose/edge/configs/Caddyfile.tmpl",
        "infra/k8s/argocd/appsets/production/candidate-a-spawny-boi-applicationset.yaml",
        "infra/k8s/argocd/appsets/production/kustomization.yaml",
        "infra/k8s/argocd/appsets/production/production-spawny-boi-applicationset.yaml",
        "infra/k8s/base/scheduler-worker/configmap.yaml",
        "infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml",
        "infra/k8s/overlays/candidate-a/spawny-boi/external-secret.yaml",
        "infra/k8s/overlays/candidate-a/spawny-boi/kustomization.yaml",
        "infra/k8s/overlays/preview/scheduler-worker/node-endpoints.patch.yaml",
        "infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml",
        "infra/k8s/overlays/production/spawny-boi/external-secret.yaml",
        "infra/k8s/overlays/production/spawny-boi/kustomization.yaml",
        "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts",
      ].sort()
    );
    expect(plan.current).toHaveLength(14);
    expect(plan.eligible).toHaveLength(0);
  });
});
