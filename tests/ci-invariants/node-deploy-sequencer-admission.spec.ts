// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-sequencer-admission`
 * Purpose: Keep the node-deploy sequencer from reading any OpenBao bucket that is not a node's own, because only a cluster-side admission policy stops it.
 * Scope: Reads the base policy and both overlay kustomizations as YAML (no kubectl needed, so CI always asserts it); does not evaluate CEL or contact a cluster.
 * Invariants: Policies ship fail-closed in base and overlays, and the sequencer may delete only mesh attempt-key Secrets (task.5430) • Each binding selects exactly the env namespaces its sequencer serves • Extra env namespaces carry the base Role rules
 * Side-effects: IO (reads reviewed manifests)
 * Links: task.5405, story.5137, task.5430, infra/k8s/base/node-deploy-sequencer/admission-policy.yaml, infra/k8s/base/node-deploy-sequencer/attempt-secret-delete-policy.yaml
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

interface DeploymentPatch {
  spec: {
    template: {
      spec: {
        containers: {
          env: {
            name: string;
            value?: string;
            valueFrom?: {
              configMapKeyRef: {
                name: string;
                key: string;
                optional?: boolean;
              };
            };
          }[];
        }[];
      };
    };
  };
}

/** The `value` of one env var the overlay sets BY NAME on the sequencer Deployment. */
function sequencerEnvEntry(kustomization: Kustomization, name: string) {
  const patch = kustomization.patches?.find(
    (p) =>
      p.target?.kind === "Deployment" &&
      p.target.name === "node-deploy-sequencer"
  );
  const doc = yaml.parse(patch?.patch ?? "") as DeploymentPatch;
  return doc.spec.template.spec.containers[0]?.env.find((e) => e.name === name);
}

/** The effective value: a literal, or the overlay's ConfigMap data its `configMapKeyRef` names. */
function sequencerEnv(kustomization: Kustomization, name: string) {
  const entry = sequencerEnvEntry(kustomization, name);
  if (entry?.value !== undefined) return entry.value;
  const ref = entry?.valueFrom?.configMapKeyRef;
  if (!ref) return undefined;
  const configPatch = kustomization.patches?.find(
    (p) => p.target?.kind === "ConfigMap" && p.target.name === ref.name
  );
  const operations = yaml.parse(configPatch?.patch ?? "[]") as {
    path: string;
    value?: string;
  }[];
  return operations.find((op) => op.path === `/data/${ref.key}`)?.value;
}

function expectFleetOwner(kustomization: Kustomization, owner: string) {
  expect(sequencerEnvEntry(kustomization, "NODE_DEPLOY_FLEET_OWNER")).toEqual({
    name: "NODE_DEPLOY_FLEET_OWNER",
    valueFrom: {
      configMapKeyRef: {
        name: "node-app-config",
        key: "NODE_SUBMODULE_PARENT_OWNER",
        optional: true,
      },
    },
  });
  const patch = kustomization.patches?.find(
    (p) => p.target?.kind === "ConfigMap" && p.target.name === "node-app-config"
  );
  const operations = yaml.parse(patch?.patch ?? "[]") as {
    op: string;
    path: string;
    value: string;
  }[];
  expect(
    operations.filter((op) => op.path === "/data/NODE_SUBMODULE_PARENT_OWNER")
  ).toEqual([
    { op: "add", path: "/data/NODE_SUBMODULE_PARENT_OWNER", value: owner },
  ]);
}

function expectWorkloadZone(kustomization: Kustomization, zone: string) {
  expect(sequencerEnv(kustomization, "NODE_DEPLOY_WORKLOAD_ZONE")).toBe(zone);
  const patch = kustomization.patches?.find(
    (p) => p.target?.kind === "ConfigMap" && p.target.name === "node-app-config"
  );
  const operations = yaml.parse(patch?.patch ?? "[]") as { path: string }[];
  // Exactly one writer of the zone value: a duplicate add would hide a conflicting second value.
  expect(
    operations.filter((op) => op.path === "/data/NODE_DEPLOY_WORKLOAD_ZONE")
  ).toHaveLength(1);
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

  it("admits exactly one database bucket: the target node's own <slug>-database-migration, for DATABASE_MIGRATION_URL only (task.5408)", () => {
    if (!policy) throw new Error("policy missing");
    const migration = (policy.spec.variables ?? []).find(
      (v) => v.name === "migrationBucket"
    )?.expression;
    // the slug is the target's own (`nd-<slug>-env`), never caller text in remoteRef
    expect(migration).toContain(
      "object.spec.target.name.substring(3, size(object.spec.target.name) - 4) + '-database-migration'"
    );
    const text = cel(policy);
    expect(text).toContain(
      "d.remoteRef.key.split('/')[1] == variables.migrationBucket"
    );
    expect(text).toContain("d.secretKey == 'DATABASE_MIGRATION_URL'");
    expect(text).toContain("d.remoteRef.property == 'DATABASE_MIGRATION_URL'");
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
    // the namespaces this env's sequencer serves: its NODE_DEPLOY_ENVS (story.5137), else only itself
    const served = sequencerEnv(kustomization, "NODE_DEPLOY_ENVS")?.split(
      ","
    ) ?? [env];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/spec/matchResources/namespaceSelector/matchExpressions/0/values",
    });
    expect([...(ops[0]?.value ?? [])].sort()).toEqual(
      served.map((e) => `cogni-node-deploy-${e}`).sort()
    );
    // the env's OWN namespace is always bound (the policy derives the env from the namespace name)
    expect(ops[0]?.value).toContain(`cogni-node-deploy-${env}`);
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

  describe("mesh attempt-Secret cleanup: delete is name-bounded to attempt keys (task.5430, HR5)", () => {
    const deleteDocs = yaml
      .parseAllDocuments(
        read(
          "infra/k8s/base/node-deploy-sequencer/attempt-secret-delete-policy.yaml"
        )
      )
      .map(
        (d) =>
          d.toJS() as Doc & {
            spec: { matchConditions?: { name: string; expression: string }[] };
          }
      );
    const deletePolicy = deleteDocs.find(
      (d) => d.kind === "ValidatingAdmissionPolicy"
    );
    const deleteBinding = deleteDocs.find(
      (d) => d.kind === "ValidatingAdmissionPolicyBinding"
    );
    /** The approved design regex (node-service-delivery §3 Cleanup bound); release ids are UUIDs. */
    const ATTEMPT_KEY_RE =
      "^nd-[0-9a-f]{8}-[a-z0-9-]+-mesh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-a[0-9]+$";
    /** The single-quoted regex inside `<subject>.matches('...')` of one CEL expression. */
    const celRegex = (expression: string | undefined, subject: string) => {
      const prefix = `${subject}.matches('`;
      const start = expression?.indexOf(prefix) ?? -1;
      if (!expression || start < 0) throw new Error(`no ${subject}.matches`);
      const from = start + prefix.length;
      return expression.slice(from, expression.indexOf("')", from));
    };
    const nameRule = deletePolicy?.spec.validations?.find((v) =>
      v.expression.includes("request.name.matches(")
    )?.expression;
    const userRule = deletePolicy?.spec.matchConditions?.find(
      (c) => c.name === "sequencer-service-account"
    )?.expression;
    const uuid = "0f8e2c1a-1b2c-4d3e-8f9a-0123456789ab";

    type RbacDoc = {
      kind: string;
      metadata: { name: string; namespace?: string };
      rules?: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
    };
    const baseRbac = yaml
      .parseAllDocuments(read("infra/k8s/base/node-deploy-sequencer/rbac.yaml"))
      .map((d) => d.toJS() as RbacDoc);
    const envRbac = yaml
      .parseAllDocuments(
        read("infra/k8s/base/node-deploy-env-namespaces/rbac.yaml")
      )
      .map((d) => d.toJS() as RbacDoc);

    it("the sequencer Role grants delete on secrets only (never on externalsecrets, never deletecollection), in Roles only", () => {
      const role = baseRbac.find((d) => d.kind === "Role");
      expect(role?.rules).toEqual([
        {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "create", "delete"],
        },
        {
          apiGroups: ["external-secrets.io"],
          resources: ["externalsecrets"],
          verbs: ["get", "create", "patch", "update"],
        },
      ]);
      for (const doc of [...baseRbac, ...envRbac]) {
        expect(doc.kind).not.toMatch(/^Cluster/);
        for (const rule of doc.rules ?? []) {
          expect(rule.verbs).not.toContain("deletecollection");
          expect(rule.verbs).not.toContain("*");
          if (rule.verbs.includes("delete"))
            expect(rule.resources).toEqual(["secrets"]);
        }
      }
    });

    it.each([
      "candidate-a",
      "production",
    ])("%s: the base Role (with delete) lands in the dedicated cogni-node-deploy-<env> namespace, never the wallet namespace", (env) => {
      const kustomization = yaml.parse(
        read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`)
      ) as Kustomization & {
        replacements?: {
          source: { fieldPath: string };
          targets: {
            select: { kind: string; name: string };
            fieldPaths: string[];
          }[];
        }[];
      };
      const placement = kustomization.replacements?.find((r) =>
        r.targets.some(
          (t) =>
            t.select.kind === "Role" &&
            t.select.name === "node-deploy-sequencer" &&
            t.fieldPaths.includes("metadata.namespace")
        )
      );
      expect(placement?.source.fieldPath).toContain(
        "NODE_DEPLOY_SECRETS_NAMESPACE"
      );
      expect(sequencerEnv(kustomization, "NODE_DEPLOY_SECRETS_NAMESPACE")).toBe(
        `cogni-node-deploy-${env}`
      );
      // the extra env Roles carry the same delete, each in its own dedicated namespace
      for (const role of envRbac.filter((d) => d.kind === "Role"))
        expect(role.metadata.namespace).toMatch(/^cogni-node-deploy-[a-z-]+$/);
    });

    it("ships a fail-closed Deny policy for Secret DELETE, bound with no namespace narrowing, and Argo delivers it", () => {
      expect(deletePolicy?.apiVersion).toBe("admissionregistration.k8s.io/v1");
      expect(deletePolicy?.spec.failurePolicy).toBe("Fail");
      expect(deletePolicy?.spec.matchConstraints?.resourceRules).toEqual([
        {
          apiGroups: [""],
          apiVersions: ["*"],
          operations: ["DELETE"],
          resources: ["secrets"],
        },
      ]);
      expect(deleteBinding?.spec.policyName).toBe(deletePolicy?.metadata.name);
      expect(deleteBinding?.spec.validationActions).toEqual(["Deny"]);
      // unset matchResources = every request the policy matches, in every namespace
      expect(deleteBinding?.spec.matchResources).toBeUndefined();
      const kust = yaml.parse(
        read("infra/k8s/base/node-deploy-sequencer/kustomization.yaml")
      ) as Kustomization;
      expect(kust.resources).toContain("attempt-secret-delete-policy.yaml");
      for (const env of ["candidate-a", "production"]) {
        const overlay = yaml.parse(
          read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`)
        ) as Kustomization;
        expect(overlay.resources).toContain(
          "../../../base/node-deploy-sequencer"
        );
        // no overlay patch may narrow or soften the delete policy
        expect(
          overlay.patches?.some((p) =>
            p.target?.name?.startsWith("node-deploy-sequencer-secret-delete")
          ) ?? false
        ).toBe(false);
      }
      // DELETE carries no `object` (null); the rule reads the request name, never object.*
      expect(cel(deletePolicy as Doc)).not.toContain("object.");
      expect(
        deletePolicy?.spec.validations?.map((v) => v.expression)
      ).toContain("request.namespace.startsWith('cogni-node-deploy-')");
    });

    it("the name rule is exactly the anchored design regex", () => {
      expect(celRegex(nameRule, "request.name")).toBe(ATTEMPT_KEY_RE);
      expect(ATTEMPT_KEY_RE.startsWith("^")).toBe(true);
      expect(ATTEMPT_KEY_RE.endsWith("$")).toBe(true);
    });

    const attemptKey = new RegExp(celRegex(nameRule, "request.name"));

    it.each([
      `nd-1234abcd-db-mesh-${uuid}-a1`,
      `nd-1234abcd-app-mesh-${uuid}-a12`,
      // a workload whose own name contains -mesh- still gets its attempt keys cleaned
      `nd-1234abcd-x-mesh-y-mesh-${uuid}-a3`,
    ])("admits the attempt key %s", (name) => {
      expect(attemptKey.test(name)).toBe(true);
    });

    it.each([
      "nd-1234abcd-db", // a state password
      "nd-1234abcd-x-mesh-y", // the state password of a workload literally named x-mesh-y
      "nd-1234abcd-x-mesh-y-a1",
      `nd-1234abcd-db-mesh-${uuid}`, // no attempt suffix
      `nd-1234abcd-db-mesh-${uuid}-a`, // attempt without digits
      `nd-1234abcd-db-mesh-${uuid}-a1-x`, // trailing text (end anchor)
      `x-nd-1234abcd-db-mesh-${uuid}-a1`, // leading text (start anchor)
      `nd-1234abcd-db-mesh-${uuid.toUpperCase()}-a1`,
      `nd-1234abc-db-mesh-${uuid}-a1`, // 7-hex node prefix
      `nd-1234abcd-mesh-${uuid}-a1`, // no workload segment
      "nd-poly-env", // an ESO-rendered env Secret
      "operator-env-secrets",
    ])("refuses deleting %s", (name) => {
      expect(attemptKey.test(name)).toBe(false);
    });

    it("applies to the sequencer ServiceAccount of every overlay and to no other principal", () => {
      const subject = new RegExp(
        celRegex(userRule, "request.userInfo.username")
      );
      const sa = yaml.parse(
        read("infra/k8s/base/node-deploy-sequencer/service-account.yaml")
      ) as { metadata: { name: string } };
      for (const env of ["candidate-a", "production"]) {
        const overlay = yaml.parse(
          read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`)
        ) as Kustomization & { namespace: string };
        const username = `system:serviceaccount:${overlay.namespace}:${overlay.namePrefix ?? ""}${sa.metadata.name}`;
        expect(subject.test(username), username).toBe(true);
      }
      for (const other of [
        "system:serviceaccount:kube-system:generic-garbage-collector",
        "system:serviceaccount:kube-system:namespace-controller",
        "system:serviceaccount:external-secrets:external-secrets",
        "system:serviceaccount:cogni-production:operator-akash-tx-actuator",
        "system:serviceaccount:cogni-production:operator-node-deploy-sequencer-x",
        "system:admin",
      ])
        expect(subject.test(other), other).toBe(false);
    });
  });

  describe("one front door: the production sequencer serves every env its cluster controls (story.5137)", () => {
    const production = yaml.parse(
      read("infra/k8s/overlays/production/operator/kustomization.yaml")
    ) as Kustomization;
    const envs = (sequencerEnv(production, "NODE_DEPLOY_ENVS") ?? "").split(
      ","
    );
    const baseRole = yaml
      .parseAllDocuments(read("infra/k8s/base/node-deploy-sequencer/rbac.yaml"))
      .map((d) => d.toJS() as { kind: string; rules?: unknown })
      .find((d) => d.kind === "Role")?.rules;

    it("serves exactly candidate-a, preview and production, and the app config names the SAME list (one list, two readers)", () => {
      expect(envs).toEqual(["candidate-a", "preview", "production"]);
      const configPatch = production.patches?.find(
        (p) =>
          p.target?.kind === "ConfigMap" && p.target.name === "node-app-config"
      );
      const ops = yaml.parse(configPatch?.patch ?? "") as {
        path: string;
        value: string;
      }[];
      expect(ops.find((o) => o.path === "/data/NODE_DEPLOY_ENVS")?.value).toBe(
        envs.join(",")
      );
    });

    it("each served env has its own dedicated namespace the admission binding selects: production from the operator overlay, the others from the sibling Application", () => {
      const primary = "cogni-node-deploy-production";
      const namespaces = (file: string) =>
        yaml
          .parseAllDocuments(read(file))
          .map((d) => d.toJS() as { kind: string; metadata: { name: string } })
          .filter((d) => d.kind === "Namespace")
          .map((d) => d.metadata.name);
      expect(
        namespaces(
          "infra/k8s/overlays/production/operator/node-deploy-secrets-namespace.yaml"
        )
      ).toEqual([primary]);
      const extra = namespaces(
        "infra/k8s/base/node-deploy-env-namespaces/namespaces.yaml"
      );
      expect(extra).toEqual(
        envs
          .filter((e) => e !== "production")
          .map((e) => `cogni-node-deploy-${e}`)
      );
      const patch = production.patches?.find(
        (p) => p.target?.kind === "ValidatingAdmissionPolicyBinding"
      );
      const bound = (yaml.parse(patch?.patch ?? "") as { value: string[] }[])[0]
        ?.value;
      expect([...(bound ?? [])].sort()).toEqual(
        envs.map((e) => `cogni-node-deploy-${e}`).sort()
      );
      // the policy derives <env> from the namespace name, so every bound namespace must be exactly that shape
      for (const ns of bound ?? [])
        expect(ns).toMatch(/^cogni-node-deploy-[a-z-]+$/);
    });

    it("every extra env namespace has the base Role's rules, bound to the sequencer ServiceAccount, in its OWN namespace, with no ClusterRole", () => {
      const docs = yaml
        .parseAllDocuments(
          read("infra/k8s/base/node-deploy-env-namespaces/rbac.yaml")
        )
        .map(
          (d) =>
            d.toJS() as {
              kind: string;
              metadata: { name: string; namespace: string };
              rules?: unknown;
              subjects?: { kind: string; name: string; namespace: string }[];
            }
        );
      expect(
        docs.some(
          (d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding"
        )
      ).toBe(false);
      for (const env of envs.filter((e) => e !== "production")) {
        const ns = `cogni-node-deploy-${env}`;
        const role = docs.find(
          (d) => d.kind === "Role" && d.metadata.namespace === ns
        );
        expect(role?.rules, `${ns} Role rules`).toEqual(baseRole);
        const binding = docs.find(
          (d) => d.kind === "RoleBinding" && d.metadata.namespace === ns
        );
        expect(binding?.subjects).toEqual([
          {
            kind: "ServiceAccount",
            name: "operator-node-deploy-sequencer",
            namespace: "cogni-production",
          },
        ]);
      }
      // nothing in the sibling directory lives in the wallet namespace
      for (const d of docs)
        expect(d.metadata.namespace).not.toBe("cogni-production");
    });

    it("the operator overlay delivers the sibling directory through an Application at the production deploy ref", () => {
      expect(production.resources).toContain(
        "./node-deploy-env-namespaces-application.yaml"
      );
      const app = yaml.parse(
        read(
          "infra/k8s/overlays/production/operator/node-deploy-env-namespaces-application.yaml"
        )
      ) as { spec: { source: { path: string; targetRevision: string } } };
      expect(app.spec.source).toMatchObject({
        path: "infra/k8s/base/node-deploy-env-namespaces",
        targetRevision: "deploy/production-operator",
      });
      const kust = yaml.parse(
        read("infra/k8s/base/node-deploy-env-namespaces/kustomization.yaml")
      ) as Record<string, unknown>;
      // a `namespace:` transformer would rename every Namespace to one name (kustomize ID conflict)
      expect(kust.namespace).toBeUndefined();
      expect(kust.namePrefix).toBeUndefined();
    });

    it.each([
      "candidate-a",
      "production",
    ])("missing new plain config cannot stop %s paid recovery before process startup", (env) => {
      const overlay = yaml.parse(
        read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`)
      ) as Kustomization;
      const patch = overlay.patches?.find(
        (p) =>
          p.target?.kind === "Deployment" &&
          p.target.name === "node-deploy-sequencer"
      );
      const deployment = yaml.parse(patch?.patch ?? "") as DeploymentPatch;
      const entries = deployment.spec.template.spec.containers[0]?.env ?? [];
      for (const name of [
        "NODE_DEPLOY_FLEET_OWNER",
        "NODE_DEPLOY_WORKLOAD_ZONE",
      ]) {
        const entry = entries.find((e) => e.name === name);
        expect(entry?.valueFrom?.configMapKeyRef.optional).toBe(true);
        expect(entry?.valueFrom?.configMapKeyRef.name).toBe("node-app-config");
      }
    });

    it("the sequencer is told its fleet org, so it never claims another fleet's nodes", () => {
      expectFleetOwner(production, "cogni-dao");
      expectWorkloadZone(production, "cognidao.org");
    });

    it("the candidate-a overlay serves only itself, and its fleet is cogni-test-org (the test operator claims no canonical node)", () => {
      const candidate = yaml.parse(
        read("infra/k8s/overlays/candidate-a/operator/kustomization.yaml")
      ) as Kustomization;
      expect(sequencerEnv(candidate, "NODE_DEPLOY_ENVS")).toBeUndefined();
      // story.5137 test lane: the test sequencer's edge guard admits only test-org nodes, never cogni-dao.
      expectFleetOwner(candidate, "cogni-test-org");
      expectWorkloadZone(candidate, "cogni-testing.org");
    });
  });
});
