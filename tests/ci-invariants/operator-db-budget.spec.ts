// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/operator-db-budget`
 * Purpose: Keep operator role budgets aligned with explicit consumer pools and rolling replicas.
 * Scope: Declarative/source invariants, not admission or legacy transition proof.
 * Invariants: App and actuator retain RLS credentials; service jobs have spare pool capacity.
 * Side-effects: IO (reads reviewed source and manifests)
 * Links: bug.5467, infra/database-budget-profiles.yaml
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");
const parse = (relative: string) => yaml.parse(read(relative));

function pool(relative: string, name: string): number {
  const source = read(relative);
  const match = source.match(
    /create(?:App|Service)DbClient\([^,]+,\s*\{\s*max:\s*(\d+),\s*applicationName:\s*"([^"]+)"/u
  );
  expect(match?.[2]).toBe(name);
  return Number(match?.[1]);
}

function rollingReplicas(relative: string): number {
  const spec = parse(relative).spec;
  const replicas = spec.replicas;
  const surge = spec.strategy?.rollingUpdate?.maxSurge ?? "25%";
  const additional =
    typeof surge === "number"
      ? surge
      : Math.ceil((replicas * Number(surge.replace("%", ""))) / 100);
  return replicas + additional;
}

describe("operator database connection envelope", () => {
  const app = pool(
    "nodes/operator/app/src/adapters/server/db/drizzle.client.ts",
    "cogni_operator_app"
  );
  const service = pool(
    "nodes/operator/app/src/adapters/server/db/drizzle.service-client.ts",
    "cogni_operator_service"
  );
  const actuator = pool(
    "nodes/operator/app/src/bootstrap/akash-tx-actuator.ts",
    "cogni_operator_akash_tx_actuator"
  );
  const worker = pool(
    "services/scheduler-worker/src/bootstrap/container.ts",
    "cogni_operator_ledger_worker"
  );
  const appReplicas = rollingReplicas(
    "infra/k8s/base/node-app/deployment.yaml"
  );
  const actuatorReplicas = rollingReplicas(
    "infra/k8s/base/akash-tx-actuator/deployment.yaml"
  );
  const workerReplicas = rollingReplicas(
    "infra/k8s/base/scheduler-worker/deployment.yaml"
  );

  it("covers simultaneous rolling consumers plus one diagnostic session per role", () => {
    const profiles = parse("infra/database-budget-profiles.yaml");
    const profile = profiles["operator-control-v1"];
    expect(profile.roles.app.connection_limit).toBe(
      appReplicas * app + actuatorReplicas * actuator + 1
    );
    expect(profile.roles.service.connection_limit).toBe(
      appReplicas * service + workerReplicas * worker + 1
    );
    expect(profile.roles.app.connection_limit).toBe(7);
    expect(profile.roles.service.connection_limit).toBe(15);
    expect(profiles["shared-default-v1"].roles.app.connection_limit).toBe(2);
    expect(profiles["shared-default-v1"].roles.service.connection_limit).toBe(
      4
    );
  });

  it("selects the operator profile in every declared operator environment", () => {
    const catalog = parse("infra/catalog/operator.yaml");
    for (const env of catalog.envs) {
      expect(catalog.database[env]).toEqual({
        tier: "shared",
        budget_profile: "operator-control-v1",
      });
    }
    expect(
      parse("infra/catalog/_schema.json").$defs.databasePlacement.properties
        .budget_profile.enum
    ).toContain("operator-control-v1");
  });

  function assertBoundedOverlay(document: ReturnType<typeof parse>) {
    const exactAudit = `exec node --input-type=module -e 'import { migrateOperatorAfterNativeDrain } from "/app/nodes/operator/app/migrate-doltgres.mjs"; await migrateOperatorAfterNativeDrain("/app/nodes/operator/app/doltgres-migrations")'`;
    const copy = structuredClone(document);
    for (const patch of copy.patches ?? []) {
      if (typeof patch.patch !== "string") continue;
      const operations = yaml.parse(patch.patch);
      if (!Array.isArray(operations)) continue;
      const strategy = operations.filter((op) =>
        String(op.path).startsWith("/spec/strategy")
      );
      if (!strategy.length) continue;
      expect(patch.target).toEqual({ kind: "Deployment", name: "node-app" });
      expect(strategy).toEqual([
        { op: "replace", path: "/spec/strategy", value: { type: "Recreate" } },
      ]);
      const audit = operations.filter(
        (op) =>
          op.path === "/spec/template/spec/initContainers/-" &&
          op.value?.name === "migrate-doltgres"
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].value.command).toEqual(["/bin/sh", "-c", exactAudit]);
      expect(audit[0].value.envFrom).toEqual([
        { configMapRef: { name: "operator-node-app-config" } },
      ]);
      expect(audit[0].value.env).toEqual([
        {
          name: "DATABASE_URL",
          valueFrom: {
            secretKeyRef: { name: "operator-env-secrets", key: "DOLTGRES_URL" },
          },
        },
      ]);
      patch.patch = yaml.stringify(
        operations.filter((op) => !strategy.includes(op))
      );
    }
    expect(yaml.stringify(copy)).not.toMatch(
      /\b(?:replicas|maxSurge|maxUnavailable)\s*:|\/spec\/(?:replicas|strategy)/u
    );
  }

  it("permits only the exact audited operator Recreate while refusing scale overrides", () => {
    expect(parse("infra/k8s/base/node-app/deployment.yaml").spec.replicas).toBe(
      1
    );
    for (const env of ["candidate-a", "preview", "production"]) {
      const overlay = parse(
        `infra/k8s/overlays/${env}/operator/kustomization.yaml`
      );
      assertBoundedOverlay(overlay);
      const extra = structuredClone(overlay);
      extra.patches.push({
        target: { kind: "Deployment", name: "node-app" },
        patch: "- op: replace\n  path: /spec/replicas\n  value: 2",
      });
      expect(() => assertBoundedOverlay(extra)).toThrow();
      const unaudited = structuredClone(overlay);
      const p = unaudited.patches.find((p: { patch: string }) =>
        p.patch.includes("/spec/strategy")
      );
      p.patch = p.patch.replace(
        "migrateOperatorAfterNativeDrain",
        "migrateDoltgres"
      );
      expect(() => assertBoundedOverlay(unaudited)).toThrow();
    }
  });

  it("keeps service capacity beyond both advisory reservations and preserves app-role actuator access", () => {
    expect(service).toBeGreaterThan(2);
    const source = read(
      "nodes/operator/app/src/bootstrap/akash-tx-actuator.ts"
    );
    expect(source).toContain("createAppDbClient(databaseUrl,");
    expect(source).not.toContain("createServiceDbClient");
    expect(source).not.toContain('readCredential("DATABASE_SERVICE_URL")');
    const productionWorker = parse(
      "infra/k8s/overlays/production/scheduler-worker/replicas.patch.yaml"
    );
    expect(productionWorker.spec.replicas).toBeLessThanOrEqual(
      parse("infra/k8s/base/scheduler-worker/deployment.yaml").spec.replicas
    );
  });
});
