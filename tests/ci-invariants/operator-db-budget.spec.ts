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

import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** Peak simultaneous pods: Recreate never overlaps; a rolling update adds its surge. */
function peakReplicas(relative: string): number {
  const spec = parse(relative).spec;
  return spec.strategy?.type === "Recreate"
    ? spec.replicas
    : rollingReplicas(relative);
}

/** Every non-test source file under `dir` that opens an operator-role pool. */
function poolCallSites(
  dir: string
): { file: string; names: string[]; calls: number }[] {
  const out: { file: string; names: string[]; calls: number }[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative))) {
      const child = `${relative}/${entry}`;
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry.startsWith("dist-")
      )
        continue;
      if (statSync(path.join(root, child)).isDirectory()) walk(child);
      else if (/\.(ts|mjs)$/u.test(entry) && !/\.(test|spec)\./u.test(entry)) {
        const source = read(child);
        const calls =
          source.match(/create(?:App|Service)DbClient\(/gu)?.length ?? 0;
        if (calls === 0) continue;
        const names = [
          ...source.matchAll(/applicationName:\s*"([^"]+)"/gu),
        ].map((m) => m[1] as string);
        out.push({ file: child, names, calls });
      }
    }
  };
  walk(dir);
  return out;
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
  // task.5400: the node-deploy sequencer opens ONE app-role connection in total (the session advisory
  // lock rides on that same connection), Recreate so never two pods.
  const sequencer = pool(
    "nodes/operator/app/src/bootstrap/node-deploy-sequencer.ts",
    "cogni_operator_node_deploy_sequencer"
  );
  const sequencerReplicas = peakReplicas(
    "infra/k8s/base/node-deploy-sequencer/deployment.yaml"
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
      appReplicas * app +
        actuatorReplicas * actuator +
        sequencerReplicas * sequencer +
        1
    );
    expect(profile.roles.service.connection_limit).toBe(
      appReplicas * service + workerReplicas * worker + 1
    );
    expect(profile.roles.app.connection_limit).toBe(8);
    expect(profile.roles.service.connection_limit).toBe(15);
    expect(profiles["shared-default-v1"].roles.app.connection_limit).toBe(2);
    expect(profiles["shared-default-v1"].roles.service.connection_limit).toBe(
      4
    );
  });

  it("budgets the sequencer at exactly one connection and never reserves a second", () => {
    expect(sequencer).toBe(1);
    expect(sequencerReplicas).toBe(1);
    const source = read(
      "nodes/operator/app/src/bootstrap/node-deploy-sequencer.ts"
    );
    expect(source).not.toMatch(/\.reserve\(/u);
  });

  it("fails when any operator pool is not accounted for in the budget formula", () => {
    const accounted = new Map<string, string>([
      [
        "cogni_operator_app",
        "nodes/operator/app/src/adapters/server/db/drizzle.client.ts",
      ],
      [
        "cogni_operator_service",
        "nodes/operator/app/src/adapters/server/db/drizzle.service-client.ts",
      ],
      [
        "cogni_operator_akash_tx_actuator",
        "nodes/operator/app/src/bootstrap/akash-tx-actuator.ts",
      ],
      [
        "cogni_operator_ledger_worker",
        "services/scheduler-worker/src/bootstrap/container.ts",
      ],
      [
        "cogni_operator_node_deploy_sequencer",
        "nodes/operator/app/src/bootstrap/node-deploy-sequencer.ts",
      ],
    ]);
    const sites = [
      ...poolCallSites("nodes/operator/app/src"),
      ...poolCallSites("services/scheduler-worker/src"),
    ];
    const seen = new Set<string>();
    for (const site of sites) {
      expect(
        site.names.length,
        `${site.file} opens a pool without a literal applicationName`
      ).toBe(site.calls);
      for (const name of site.names) {
        expect(
          accounted.get(name),
          `${site.file}: pool "${name}" is not in the budget formula`
        ).toBe(site.file);
        seen.add(name);
      }
    }
    // and every accounted pool still exists (a removed pool must also leave the formula)
    expect([...seen].sort()).toEqual([...accounted.keys()].sort());
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
