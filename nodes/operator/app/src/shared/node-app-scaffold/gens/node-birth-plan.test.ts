// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { nodeBirthPathPlan } from "./node-birth-plan";

describe("nodeBirthPathPlan", () => {
  it("names the seven-path target but keeps eligibility empty", () => {
    const plan = nodeBirthPathPlan({
      slug: "atlas",
      controlEnvFor: () => "production",
    });

    expect(plan.isolatedTarget).toEqual(
      [
        "infra/catalog/atlas.yaml",
        "infra/k8s/argocd/appsets/production/candidate-a-atlas-applicationset.yaml",
        "infra/k8s/argocd/appsets/production/production-atlas-applicationset.yaml",
        "infra/k8s/overlays/candidate-a/atlas/external-secret.yaml",
        "infra/k8s/overlays/candidate-a/atlas/kustomization.yaml",
        "infra/k8s/overlays/production/atlas/external-secret.yaml",
        "infra/k8s/overlays/production/atlas/kustomization.yaml",
      ].sort()
    );
    expect(plan.isolatedTarget).toHaveLength(7);
    expect(plan.eligible).toEqual([]);
    expect(plan.blockers).toHaveLength(4);
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
