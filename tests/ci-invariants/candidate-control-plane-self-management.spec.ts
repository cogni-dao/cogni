// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-control-plane-self-management`
 * Purpose: Pins the candidate-a control-plane root Application to one shape in both its apply-once seed and its self-managing copy.
 * Scope: Static assertions over the two YAML manifests; does not contact a cluster, Argo CD, or GitHub.
 * Invariants:
 *   SEED_AND_SELF_ARE_THE_SAME_OBJECT: the apply-once seed under roots/ and the
 *     self-managing copy inside control-plane/candidate-a/ parse to the same
 *     identity, source, destination and syncPolicy, so Argo adopts the seeded
 *     Application instead of fighting it.
 *   CONTROL_PLANE_TRACKS_THE_DEPLOY_REF: the root tracks
 *     deploy/candidate-a-control-plane, never main, so a reviewed-but-unmerged
 *     control-plane shape is flightable on candidate-a.
 *   CONTROL_PLANE_OWNS_ONLY_ITS_ENV_DIR: the root's source path is scoped to
 *     infra/k8s/argocd/control-plane/candidate-a, preventing a foreign-env fan-out.
 * Side-effects: IO (reads the two candidate-a control-plane Application manifests)
 * Links: infra/k8s/argocd/control-plane/roots/candidate-a-control-plane-application.yaml, nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CONTROL_PLANE_REF = "deploy/candidate-a-control-plane";
const CONTROL_PLANE_PATH = "infra/k8s/argocd/control-plane/candidate-a";
const SELF_PATH = `${CONTROL_PLANE_PATH}/candidate-a-control-plane-application.yaml`;
const SEED_PATH =
  "infra/k8s/argocd/control-plane/roots/candidate-a-control-plane-application.yaml";

interface ControlPlaneApplication {
  apiVersion?: unknown;
  kind?: unknown;
  metadata?: {
    name?: unknown;
    namespace?: unknown;
    finalizers?: unknown;
  };
  spec?: {
    project?: unknown;
    source?: { targetRevision?: unknown; path?: unknown };
    destination?: unknown;
    syncPolicy?: unknown;
  };
}

function loadApplication(relativePath: string): ControlPlaneApplication {
  return yaml.parse(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
  ) as ControlPlaneApplication;
}

function identityOf(app: ControlPlaneApplication) {
  return {
    apiVersion: app.apiVersion,
    kind: app.kind,
    name: app.metadata?.name,
    namespace: app.metadata?.namespace,
    finalizers: app.metadata?.finalizers,
  };
}

const self = loadApplication(SELF_PATH);
const seed = loadApplication(SEED_PATH);

describe("candidate-a control-plane self-management", () => {
  it("seeds and self-manages the same Application identity", () => {
    expect(identityOf(seed)).toEqual(identityOf(self));
    expect(identityOf(self)).toEqual({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      name: "cogni-candidate-a-control-plane",
      namespace: "argocd",
      finalizers: ["resources-finalizer.argocd.argoproj.io"],
    });
  });

  it("seeds and self-manages the same source, destination and syncPolicy", () => {
    expect(seed.spec?.source).toEqual(self.spec?.source);
    expect(seed.spec?.destination).toEqual(self.spec?.destination);
    expect(seed.spec?.syncPolicy).toEqual(self.spec?.syncPolicy);
    expect(seed.spec?.project).toEqual(self.spec?.project);
  });

  it("tracks the candidate-a control-plane deploy ref, not main", () => {
    expect(self.spec?.source?.targetRevision).toBe(CONTROL_PLANE_REF);
    expect(seed.spec?.source?.targetRevision).toBe(CONTROL_PLANE_REF);
  });

  it("owns only the candidate-a control-plane directory", () => {
    expect(self.spec?.source?.path).toBe(CONTROL_PLANE_PATH);
    expect(seed.spec?.source?.path).toBe(CONTROL_PLANE_PATH);
  });
});
