// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-sequencer-admission`
 * Purpose: The node-deploy sequencer can create ExternalSecrets in its dedicated namespace and read the
 *   Secrets they render, while ESO's ClusterSecretStore reads `cogni/data/*`. The ONLY thing that stops
 *   it reading a bucket it must never see (the akash-tx actuator wallet, the operator's own secrets, the
 *   database-reliability credentials) is the cluster-side ValidatingAdmissionPolicy shipped with it
 *   (task.5405). This spec pins that the policy and its binding exist in BOTH overlays' rendered output,
 *   are fail-closed, bound to exactly that overlay's dedicated namespace, and name every denied bucket.
 * Invariants:
 *   - POLICY_SHIPS_IN_EVERY_OVERLAY: candidate-a and production both render the policy and the binding.
 *   - FAIL_CLOSED: failurePolicy Fail, validationActions [Deny], CREATE and UPDATE of externalsecrets.
 *   - BOUND_TO_ITS_OWN_NAMESPACE: the binding selects `cogni-node-deploy-<env>` and nothing else, and its
 *     policyName matches the rendered (prefixed) policy name.
 *   - DENIED_BUCKETS_ARE_NAMED: operator, akash-tx-actuator, _system, _shared, database-reliability*,
 *     *-database-migration are all in the policy; the store is pinned; dataFrom and per-entry sourceRef
 *     are forbidden; the key must start with this namespace's env; the target is `nd-`.
 *   - SEQUENCER_ROLE_STAYS_SCOPED: the Role keeps externalsecrets verbs only inside its namespace.
 * Side-effects: filesystem read; `kubectl kustomize` (skipped when kubectl is absent)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");

interface Doc {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: {
    failurePolicy?: string;
    policyName?: string;
    validationActions?: string[];
    matchConstraints?: { resourceRules: unknown[] };
    matchResources?: {
      namespaceSelector: { matchExpressions: unknown[] };
    };
    variables?: { expression: string }[];
    validations?: { expression: string }[];
  };
}

const kubectlAvailable = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function render(relative: string): Doc[] {
  const out = execFileSync(
    "kubectl",
    ["kustomize", path.join(REPO_ROOT, relative)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return yaml.parseAllDocuments(out).map((d) => d.toJS() as Doc);
}

const DENIED = [
  "operator",
  "akash-tx-actuator",
  "_system",
  "_shared",
  "database-reliability",
  "-database-migration",
];

function expressions(policy: Doc): string {
  const validations = policy.spec.validations ?? [];
  const variables = policy.spec.variables ?? [];
  return [...variables, ...validations].map((v) => v.expression).join("\n");
}

describe("node-deploy sequencer ExternalSecret admission policy (task.5405)", () => {
  it.skipIf(!kubectlAvailable).each(["candidate-a", "production"])(
    "%s: the overlay renders the policy and a Deny binding bound to its own dedicated namespace",
    (env) => {
      const docs = render(`infra/k8s/overlays/${env}/operator`);
      const policy = docs.find(
        (d) =>
          d.kind === "ValidatingAdmissionPolicy" &&
          d.metadata.name.endsWith("node-deploy-sequencer-externalsecrets")
      );
      const binding = docs.find(
        (d) =>
          d.kind === "ValidatingAdmissionPolicyBinding" &&
          d.metadata.name.endsWith("node-deploy-sequencer-externalsecrets")
      );
      expect(
        policy,
        `${env} must render the ValidatingAdmissionPolicy`
      ).toBeDefined();
      expect(binding, `${env} must render the binding`).toBeDefined();
      if (!policy || !binding) return;
      expect(policy.apiVersion).toBe("admissionregistration.k8s.io/v1");

      // fail closed
      expect(policy.spec.failurePolicy).toBe("Fail");
      expect(binding.spec.validationActions).toEqual(["Deny"]);
      expect(policy.spec.matchConstraints?.resourceRules).toEqual([
        {
          apiGroups: ["external-secrets.io"],
          apiVersions: ["*"],
          operations: ["CREATE", "UPDATE"],
          resources: ["externalsecrets"],
        },
      ]);

      // the binding points at the (prefixed) policy and selects ONLY this env's dedicated namespace
      expect(binding.spec.policyName).toBe(policy.metadata.name);
      expect(
        binding.spec.matchResources?.namespaceSelector.matchExpressions
      ).toEqual([
        {
          key: "kubernetes.io/metadata.name",
          operator: "In",
          values: [`cogni-node-deploy-${env}`],
        },
      ]);
    }
  );

  it.skipIf(!kubectlAvailable).each(["candidate-a", "production"])(
    "%s: the policy pins the store, forbids dataFrom and sourceRef, scopes keys to the env and names every denied bucket",
    (env) => {
      const policy = render(`infra/k8s/overlays/${env}/operator`).find(
        (d) => d.kind === "ValidatingAdmissionPolicy"
      );
      expect(policy).toBeDefined();
      if (!policy) return;
      const cel = expressions(policy);
      // store pinned
      expect(cel).toContain(
        "object.spec.secretStoreRef.kind == 'ClusterSecretStore'"
      );
      expect(cel).toContain(
        "object.spec.secretStoreRef.name == 'openbao-backend'"
      );
      // a whole-bucket / prefix render and a per-entry store override are impossible
      expect(cel).toContain("!has(object.spec.dataFrom)");
      expect(cel).toContain("!has(d.sourceRef)");
      // keys are <this namespace's env>/<slug>
      expect(cel).toContain(
        "object.metadata.namespace.replace('cogni-node-deploy-', '')"
      );
      expect(cel).toContain("'/[a-z][a-z0-9-]{0,62}$'");
      // every denied bucket
      for (const bucket of DENIED) expect(cel, bucket).toContain(bucket);
      expect(cel).toContain("startsWith('database-reliability')");
      expect(cel).toContain("endsWith('-database-migration')");
      // the rendered Secret can only be an nd- Secret
      expect(cel).toContain("object.spec.target.name.startsWith('nd-')");
    }
  );

  it("the base ships the policy next to the sequencer's Role, which keeps externalsecrets verbs in its own namespace only", () => {
    const kustomization = readFileSync(
      path.join(
        REPO_ROOT,
        "infra/k8s/base/node-deploy-sequencer/kustomization.yaml"
      ),
      "utf8"
    );
    expect(kustomization).toContain("admission-policy.yaml");
    const rbac = yaml
      .parseAllDocuments(
        readFileSync(
          path.join(
            REPO_ROOT,
            "infra/k8s/base/node-deploy-sequencer/rbac.yaml"
          ),
          "utf8"
        )
      )
      .map((d) => d.toJS() as Doc);
    expect(rbac.some((d) => d.kind === "Role")).toBe(true);
    expect(rbac.some((d) => d.kind === "ClusterRole")).toBe(false);
  });
});
