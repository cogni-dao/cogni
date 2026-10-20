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
 *   CONTROL_PLANE_TRACKS_ITS_FLEET_REF: every fleet's root tracks its own reviewed
 *     deploy ref, so unmerged control-plane state can be proven before canonical merge.
 *   CHILD_APPSETS_SHARE_FLEET_AUTHORITY: the child app-of-apps resolves from the
 *     same repository as its owning root, so self-heal cannot restore another fleet.
 *   DECLARATIVE_RECONCILIATION_ONLY: candidate flights never mutate the root with
 *     kubectl; Argo continuously reconciles the Git-owned self-managing copy.
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
const APPSETS_PATH = `${CONTROL_PLANE_PATH}/candidate-a-appsets-application.yaml`;
const CANDIDATE_FLIGHT_PATH = ".github/workflows/candidate-flight.yml";

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
    source?: { repoURL?: unknown; targetRevision?: unknown; path?: unknown };
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
const appsets = loadApplication(APPSETS_PATH);

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

  it("keeps every fleet root flightable through its reviewed deploy ref", () => {
    expect(self.spec?.source?.targetRevision).toBe(CONTROL_PLANE_REF);
    expect(seed.spec?.source?.targetRevision).toBe(CONTROL_PLANE_REF);
  });

  it("keeps the child AppSet reconciler on the owning fleet", () => {
    expect(appsets.spec?.source?.repoURL).toBe(self.spec?.source?.repoURL);
    expect(appsets.spec?.source?.targetRevision).toBe("main");
    expect(appsets.spec?.source?.path).toBe(
      "infra/k8s/argocd/appsets/candidate-a"
    );
  });

  it("leaves root reconciliation to Argo instead of each candidate flight", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, CANDIDATE_FLIGHT_PATH),
      "utf8"
    );

    expect(workflow).not.toContain(
      "Reconcile isolated fleet control-plane root"
    );
    expect(workflow).not.toContain("candidate-a-control-plane-root.yaml");
  });

  it("owns only the candidate-a control-plane directory", () => {
    expect(self.spec?.source?.path).toBe(CONTROL_PLANE_PATH);
    expect(seed.spec?.source?.path).toBe(CONTROL_PLANE_PATH);
  });
});
