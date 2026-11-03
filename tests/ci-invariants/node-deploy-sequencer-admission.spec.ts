// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-sequencer-admission`
 * Purpose: Keep the node-deploy sequencer from reading any OpenBao bucket that is not a node's own, because only a cluster-side admission policy stops it.
 * Scope: Reads the base policy and both overlay kustomizations as YAML (no kubectl needed, so CI always asserts it); does not evaluate CEL or contact a cluster.
 * Invariants: Policy ships fail-closed in base and both overlays • The binding selects only its own namespace • Every non-node bucket is named
 * Side-effects: IO (reads reviewed manifests)
 * Links: task.5405, infra/k8s/base/node-deploy-sequencer/admission-policy.yaml
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

interface Doc {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    failurePolicy?: string;
    policyName?: string;
    validationActions?: string[];
    matchConstraints?: { resourceRules: unknown[] };
    matchResources?: { namespaceSelector: { matchExpressions: unknown[] } };
    variables?: { name: string; expression: string }[];
    validations?: { expression: string }[];
  };
}

interface Kustomization {
  resources: string[];
  namePrefix?: string;
  patches?: { target?: { kind?: string; name?: string }; patch?: string }[];
}

const base = yaml
  .parseAllDocuments(
    read("infra/k8s/base/node-deploy-sequencer/admission-policy.yaml")
  )
  .map((d) => d.toJS() as Doc);
const policy = base.find((d) => d.kind === "ValidatingAdmissionPolicy");
const binding = base.find((d) => d.kind === "ValidatingAdmissionPolicyBinding");

/** Every non-node bucket found in secret-materialize.sh, reconcile-secrets.sh and the catalogs. */
const DENIED_EXACT = [
  "operator",
  "scheduler-worker",
  "akash-tx-actuator",
  "_system",
  "_shared",
  "openfga",
  "litellm",
  "doltgres",
  "temporal",
  "postgres",
  "redis",
  "grafana",
  "loki",
];

/** The materializer's `database` buckets, all caught by the substring rule. */
const DATABASE_BUCKETS = [
  "database-reliability-actuator",
  "database-reliability-readmitter",
  "poly-database-migration",
  "poly-database-cell",
  "poly-database-backup",
  "poly-database-recovery-probe",
];

function cel(doc: Doc): string {
  return [...(doc.spec.variables ?? []), ...(doc.spec.validations ?? [])]
    .map((v) => v.expression)
    .join("\n");
}

describe("node-deploy sequencer ExternalSecret admission policy (task.5405)", () => {
  it("the base ships a fail-closed Deny policy for externalsecrets CREATE and UPDATE", () => {
    expect(policy?.apiVersion).toBe("admissionregistration.k8s.io/v1");
    expect(policy?.spec.failurePolicy).toBe("Fail");
    expect(binding?.spec.validationActions).toEqual(["Deny"]);
    expect(policy?.spec.matchConstraints?.resourceRules).toEqual([
      {
        apiGroups: ["external-secrets.io"],
        apiVersions: ["*"],
        operations: ["CREATE", "UPDATE"],
        resources: ["externalsecrets"],
      },
    ]);
    expect(binding?.spec.policyName).toBe(policy?.metadata.name);
    expect(
      read("infra/k8s/base/node-deploy-sequencer/kustomization.yaml")
    ).toContain("admission-policy.yaml");
  });

  it("pins the store, forbids dataFrom and per-entry sourceRef, scopes keys to the namespace env and requires an nd- target", () => {
    if (!policy) throw new Error("policy missing");
    const text = cel(policy);
    expect(text).toContain(
      "object.spec.secretStoreRef.kind == 'ClusterSecretStore'"
    );
    expect(text).toContain(
      "object.spec.secretStoreRef.name == 'openbao-backend'"
    );
    expect(text).toContain("!has(object.spec.dataFrom)");
    expect(text).toContain("!has(d.sourceRef)");
    expect(text).toContain(
      "object.metadata.namespace.replace('cogni-node-deploy-', '')"
    );
    expect(text).toContain("'/[a-z][a-z0-9-]{0,62}$'");
    expect(text).toContain("object.spec.target.name.startsWith('nd-')");
  });

  it("names every non-node bucket and denies any bucket containing `database`", () => {
    if (!policy) throw new Error("policy missing");
    const variables = policy.spec.variables ?? [];
    const denied = variables.find(
      (v) => v.name === "deniedBuckets"
    )?.expression;
    expect(denied).toBeDefined();
    const listed = [...(denied ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...DENIED_EXACT].sort());
    for (const bucket of DENIED_EXACT) expect(listed, bucket).toContain(bucket);
    expect(cel(policy)).toContain(
      "!d.remoteRef.key.split('/')[1].contains('database')"
    );
    // the materializer's database buckets are covered by the substring rule, not by luck
    for (const bucket of DATABASE_BUCKETS) expect(bucket).toContain("database");
  });

  it.each([
    "candidate-a",
    "production",
  ])("%s: the overlay includes the sequencer base and binds the policy to exactly its own dedicated namespace", (env) => {
    const kustomization = yaml.parse(
      read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`)
    ) as Kustomization;
    expect(kustomization.resources).toContain(
      "../../../base/node-deploy-sequencer"
    );
    const patch = kustomization.patches?.find(
      (p) =>
        p.target?.kind === "ValidatingAdmissionPolicyBinding" &&
        p.target.name === binding?.metadata.name
    );
    expect(patch, `${env} must patch the binding`).toBeDefined();
    const ops = yaml.parse(patch?.patch ?? "") as {
      op: string;
      path: string;
      value: string[];
    }[];
    expect(ops).toEqual([
      {
        op: "replace",
        path: "/spec/matchResources/namespaceSelector/matchExpressions/0/values",
        value: [`cogni-node-deploy-${env}`],
      },
    ]);
    // the base binding selects by namespace name, so the patch above is what scopes it
    expect(
      binding?.spec.matchResources?.namespaceSelector.matchExpressions
    ).toEqual([
      {
        key: "kubernetes.io/metadata.name",
        operator: "In",
        values: ["replace-in-overlay"],
      },
    ]);
  });

  it("the sequencer Role keeps externalsecrets verbs inside its own namespace (no ClusterRole)", () => {
    const rbac = yaml
      .parseAllDocuments(read("infra/k8s/base/node-deploy-sequencer/rbac.yaml"))
      .map((d) => d.toJS() as { kind: string });
    expect(rbac.some((d) => d.kind === "Role")).toBe(true);
    expect(rbac.some((d) => d.kind === "ClusterRole")).toBe(false);
  });
});
