// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@tests/ci-invariants/preview-deployment-boundary`
 * Purpose: Preserve opt-in preview ownership outside ordinary flight pruning boundaries.
 * Scope: Reads declarative Argo and Crossplane source. Does not deploy or contact providers.
 * Invariants: Preview branch/tree/Argo owner are independent; ordinary AppSets never own them;
 *   immutable admission identity and database generation travel on the correct actuator wire.
 * Side-effects: IO (reads repository manifests).
 * Links: infra/crossplane/xcomputeworkload/composition.yaml,
 *   infra/k8s/argocd/preview-pilot/candidate-a-previews-application.yaml
 * @public
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const app = parse(
  read("infra/k8s/argocd/preview-pilot/candidate-a-previews-application.yaml")
);

describe("independent opt-in preview desired state", () => {
  it("keeps cleanup observation opt-in, namespace-scoped and read-only", () => {
    const text = read(
      "infra/k8s/argocd/preview-pilot/preview-cleanup-observer-rbac.yaml"
    );
    const [role, binding] = parseAllDocuments(text).map((document) =>
      document.toJSON()
    );
    expect(role.kind).toBe("Role");
    expect(role.metadata).toEqual({
      name: "preview-cleanup-observer",
      namespace: "cogni-candidate-a",
    });
    expect(role.rules).toEqual([
      {
        apiGroups: ["compute.cogni.io"],
        resources: ["xcomputeworkloads"],
        verbs: ["get", "list"],
      },
      {
        apiGroups: ["http.m.crossplane.io"],
        resources: ["requests"],
        verbs: ["get", "list"],
      },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    ]);
    expect(binding.kind).toBe("RoleBinding");
    expect(binding.metadata).toEqual(role.metadata);
    expect(binding.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: "operator-secrets-writer",
        namespace: "cogni-candidate-a",
      },
    ]);
    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: "preview-cleanup-observer",
    });
    expect(text).not.toContain("ClusterRole");
    expect(read("infra/k8s/argocd/kustomization.yaml")).not.toContain(
      "preview-cleanup-observer"
    );
    for (const file of readdirSync(
      path.join(root, "infra/k8s/argocd/control-plane/candidate-a")
    )) {
      if (file.endsWith(".yaml"))
        expect(
          read(`infra/k8s/argocd/control-plane/candidate-a/${file}`)
        ).not.toContain("preview-cleanup-observer");
    }
  });
  it("has a separate branch, source tree and Argo owner outside ordinary node overlays", () => {
    expect(app.metadata.name).toBe("cogni-candidate-a-previews");
    expect(app.spec.source).toMatchObject({
      repoURL: "https://github.com/cogni-dao/cogni.git",
      targetRevision: "deploy/candidate-a-previews",
      path: "infra/k8s/preview-deployments/candidate-a",
      directory: { recurse: true, exclude: "**/kustomization.yaml" },
    });
    expect(app.spec.source.path.startsWith("infra/k8s/overlays/")).toBe(false);
    expect(app.spec.syncPolicy.automated).toEqual({
      prune: true,
      selfHeal: true,
      allowEmpty: true,
    });
    const materializer = read(
      ".github/actions/materialize-compute-workload/action.yml"
    );
    expect(materializer).not.toContain("preview-deployments");
    expect(materializer).not.toContain("candidate-a-previews");
  });
  it("is dormant until explicitly staged, and ordinary AppSets cannot own its resources", () => {
    for (const env of ["candidate-a", "preview", "production"]) {
      for (const file of readdirSync(
        path.join(root, "infra/k8s/argocd/control-plane", env)
      )) {
        if (!file.endsWith(".yaml")) continue;
        expect(
          read(`infra/k8s/argocd/control-plane/${env}/${file}`)
        ).not.toContain("cogni-candidate-a-previews");
      }
      for (const file of readdirSync(
        path.join(root, "infra/k8s/argocd/appsets", env)
      )) {
        if (!file.endsWith(".yaml")) continue;
        expect(read(`infra/k8s/argocd/appsets/${env}/${file}`)).not.toContain(
          "preview-deployments"
        );
      }
    }
  });
  it("requires admission identity and matching reset generation before preview create", () => {
    const source = read("infra/crossplane/xcomputeworkload/composition.yaml");
    expect(source).toContain("sha256sum $previewId");
    expect(source).toContain(
      "previewDeploymentId: .payload.body.previewDeploymentId"
    );
    expect(source).toContain(
      "previewResetGeneration: .payload.body.previewResetGeneration"
    );
    expect(source).toContain(
      'set $migrationStep "previewDeploymentId" $previewId'
    );
    expect(source).toContain(
      'set $migrationStep "previewStateSlot" $spec.previewStateSlot'
    );
    expect(source).toContain(
      'printf "%s-preview-%s-compute-env-secrets" $slug $pair'
    );
  });
});
