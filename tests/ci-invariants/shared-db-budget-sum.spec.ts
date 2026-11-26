// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/shared-db-budget-sum`
 * Purpose: Keep the sum of every lane-resident node's role caps under each env's Postgres ceiling.
 * Scope: Declarative catalog + budget-profile arithmetic; mirrors reconcile-node-substrate.sh scaling. Does not read live Postgres or prove admission.
 * Invariants: Caps scale by catalog `copies` / profile `copies`; per env sum <= env_max_connections[env] - reserve. A non-production `dedicated` row without `placement: akash-cell` keeps its roles on the lane Postgres, so it counts (bug.5645).
 * Side-effects: IO (reads infra/catalog and infra/database-budget-profiles.yaml)
 * Links: bug.5637, bug.5645, story.5159, database-expert axiom 3, noisy-neighbor-database-architecture
 * @internal
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const ENVS = ["candidate-a", "preview", "production"] as const;
// The per-env ceiling is declared in infra/compose/runtime/configs/postgres-limits.yaml `env_max_connections`;
// deploy-infra.sh passes the same value to the shared Postgres (`-c max_connections`, default 100).
// Reserve covers superuser slots, the readonly exporter/Grafana role, support sessions and one
// migration burst outside node budgets.
const RESERVE = 15;

interface Profile {
  copies?: number;
  roles: {
    app: { connection_limit: number };
    service: { connection_limit: number };
  };
}
const profiles = yaml.parse(
  readFileSync(path.join(root, "infra/database-budget-profiles.yaml"), "utf8")
) as Record<string, Profile>;
const { env_max_connections: envMaxConnections } = yaml.parse(
  readFileSync(
    path.join(root, "infra/compose/runtime/configs/postgres-limits.yaml"),
    "utf8"
  )
) as { env_max_connections: Record<string, number> };

const catalogs = readdirSync(path.join(root, "infra/catalog"))
  .filter((f) => f.endsWith(".yaml"))
  .map(
    (f) =>
      yaml.parse(readFileSync(path.join(root, "infra/catalog", f), "utf8")) as {
        name: string;
        database?: Record<
          string,
          {
            tier: string;
            budget_profile: string;
            copies?: number;
            placement?: string;
            runtimePoolLimits?: {
              replicaCount: number;
              app: number;
              service: number;
              read: number;
            };
          }
        >;
      }
  );

/** Same rounding as reconcile-node-substrate.sh: ceil(cap * copies / profile copies). */
function scaled(
  cap: number,
  copies: number | undefined,
  base: number | undefined
) {
  if (copies === undefined) return cap;
  if (!base || copies < base) throw new Error("copies below profile base");
  return Math.ceil((cap * copies) / base);
}

/**
 * A row's roles live on this env's Postgres when it is shared, or when it is a non-production
 * dedicated row that has no applied `akash-cell` placement (poly candidate-a and preview).
 */
function onLanePostgres(
  env: (typeof ENVS)[number],
  placement: { tier: string; placement?: string }
) {
  return (
    placement.tier === "shared" ||
    (env !== "production" && placement.placement !== "akash-cell")
  );
}

/** Sum of every lane-resident node's role caps declared for one env. */
function roleCapSum(env: (typeof ENVS)[number]) {
  let sum = 0;
  for (const node of catalogs) {
    const placement = node.database?.[env];
    if (!placement || !onLanePostgres(env, placement)) continue;
    const profile = profiles[placement.budget_profile];
    expect(profile, `${node.name}: unknown profile`).toBeDefined();
    if (!profile) continue;
    // app + service + migration (1) + recovery probe (1)
    sum +=
      scaled(
        profile.roles.app.connection_limit,
        placement.copies,
        profile.copies
      ) +
      scaled(
        profile.roles.service.connection_limit,
        placement.copies,
        profile.copies
      ) +
      2;
  }
  return sum;
}

describe("shared database budget sum (bug.5637)", () => {
  it.each(ENVS)("%s role caps fit the env Postgres ceiling", (env) => {
    const maxConnections = envMaxConnections[env];
    expect(
      Number.isInteger(maxConnections),
      `${env}: env_max_connections`
    ).toBe(true);
    expect(maxConnections).toBeGreaterThanOrEqual(20);
    expect(maxConnections).toBeLessThanOrEqual(500);
    expect(roleCapSum(env)).toBeLessThanOrEqual(maxConnections - RESERVE);
  });

  // candidate-a is deliberately sized for the raised 200 ceiling (per-dev test envs, story.5159).
  it.each([
    "preview",
    "production",
  ] as const)("%s current catalog also fits the image-default ceiling of 100", (env) => {
    expect(roleCapSum(env)).toBeLessThanOrEqual(100 - RESERVE);
  });

  it("only candidate-a raises the ceiling above the image default", () => {
    expect(envMaxConnections).toEqual({
      "candidate-a": 200,
      preview: 100,
      production: 100,
    });
  });

  it("node-template candidate-a caps cover 3 workloads x (live + spare) + 5 test envs", () => {
    const nt = catalogs.find((c) => c.name === "node-template");
    const placement = nt?.database?.["candidate-a"];
    const profile = profiles[placement?.budget_profile ?? ""];
    expect(placement?.copies).toBe(12);
    expect(
      scaled(
        profile?.roles.app.connection_limit ?? 0,
        placement?.copies,
        profile?.copies
      )
    ).toBe(12);
    expect(
      scaled(
        profile?.roles.service.connection_limit ?? 0,
        placement?.copies,
        profile?.copies
      )
    ).toBe(24);
  });

  it("shared app nodes on candidate-a cover live + spare + 5 test envs", () => {
    for (const name of ["beacon", "levelup", "red", "toks5"]) {
      const c = catalogs.find((n) => n.name === name);
      expect(c?.database?.["candidate-a"]?.copies, name).toBe(7);
    }
  });

  // bug.5645: poly's candidate-a and preview lanes. A release runs the serving pod, the new blue pod
  // and the app's qualification (one dedicated app-role connection) at once, and a failed release
  // leaves its pod holding connections until retired. Pools stay below the caps, one reserved per role.
  describe.each([
    "candidate-a",
    "preview",
  ] as const)("poly %s role caps cover blue/green and qualification", (env) => {
    const poly = catalogs.find((c) => c.name === "poly");
    const placement = poly?.database?.[env];
    const profile = profiles[placement?.budget_profile ?? ""];
    const pools = placement?.runtimePoolLimits;
    const appCap = scaled(
      profile?.roles.app.connection_limit ?? 0,
      placement?.copies,
      profile?.copies
    );
    const serviceCap = scaled(
      profile?.roles.service.connection_limit ?? 0,
      placement?.copies,
      profile?.copies
    );
    // poly bootstrap/qualification.ts: one transient app-role connection per qualification.
    const QUALIFICATION_APP_CONNECTIONS = 1;
    const RESERVE = 1;
    // Per pod service_poly: service pool + read pool + one job-leader connection.
    const LEADER_CONNECTIONS = 1;

    it("declares copies and explicit pool limits", () => {
      expect(profile?.copies).toBe(2);
      expect(placement?.copies).toBe(4);
      expect(pools).toEqual({ replicaCount: 1, app: 1, service: 1, read: 1 });
    });

    it("app_poly fits serving + blue + qualification with one reserved", () => {
      expect(appCap).toBe(4);
      const demand = 2 * (pools?.app ?? 0) + QUALIFICATION_APP_CONNECTIONS;
      expect(demand + RESERVE).toBeLessThanOrEqual(appCap);
    });

    it("service_poly fits every simultaneous copy with one reserved", () => {
      expect(serviceCap).toBe(16);
      const perPod =
        (pools?.service ?? 0) + (pools?.read ?? 0) + LEADER_CONNECTIONS;
      expect(perPod * (placement?.copies ?? 0) + RESERVE).toBeLessThanOrEqual(
        serviceCap
      );
    });
  });
});
