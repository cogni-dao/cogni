// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/shared-db-budget-sum`
 * Purpose: Keep the sum of every lane-resident node's role caps under each env's Postgres ceiling.
 * Scope: Declarative catalog + budget-profile arithmetic; mirrors reconcile-node-substrate.sh scaling. Does not read live Postgres or prove admission.
 * Invariants: Caps scale by catalog `copies` / profile `copies`; per env sum <= env_max_connections[env] - reserve. A non-production `dedicated` row without `placement: akash-cell` keeps its roles on the lane Postgres, so it counts; a row's `roleConnectionLimits` replaces profile x copies for that row (bug.5645).
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
            roleConnectionLimits?: { app: number; service: number };
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

interface Placement {
  tier: string;
  budget_profile: string;
  copies?: number;
  placement?: string;
  roleConnectionLimits?: { app: number; service: number };
}

/** The native role caps reconcile-node-substrate.sh applies to a row: declared directly, else profile x copies. */
function roleCaps(placement: Placement, profile: Profile) {
  if (placement.roleConnectionLimits) return placement.roleConnectionLimits;
  return {
    app: scaled(
      profile.roles.app.connection_limit,
      placement.copies,
      profile.copies
    ),
    service: scaled(
      profile.roles.service.connection_limit,
      placement.copies,
      profile.copies
    ),
  };
}

/** Role-connection sum of every lane-resident node declared for one env. */
function roleCapSum(env: (typeof ENVS)[number]) {
  let sum = 0;
  for (const node of catalogs) {
    const placement = node.database?.[env];
    if (!placement || !onLanePostgres(env, placement)) continue;
    const profile = profiles[placement.budget_profile];
    expect(profile, `${node.name}: unknown profile`).toBeDefined();
    if (!profile) continue;
    const caps = roleCaps(placement, profile);
    // app + service + migration (1) + recovery probe (1)
    sum += caps.app + caps.service + 2;
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

  // bug.5645: poly's candidate-a and preview lanes, sized from ONE model (documented in poly.yaml):
  // simultaneous pods N, each holding its pools plus one transient qualification connection and one
  // job leader, with one connection reserved per role. Everything below is derived from the catalog.
  //   N = live + retiring (the sequencer keeps a replaced lease for 10 minutes) + blue.
  const SIMULTANEOUS_PODS = 3;
  // poly bootstrap/qualification.ts: one transient app-role connection per process.
  const QUALIFICATION_APP_CONNECTIONS = 1;
  // Per pod service_poly: service pool + read pool + one job-leader connection.
  const LEADER_CONNECTIONS = 1;
  const RESERVE = 1;

  describe.each([
    "candidate-a",
    "preview",
  ] as const)("poly %s role caps cover every simultaneous pod", (env) => {
    const poly = catalogs.find((c) => c.name === "poly");
    const placement = poly?.database?.[env];
    const pools = placement?.runtimePoolLimits;
    const caps = placement?.roleConnectionLimits;

    it("declares explicit pools and role caps, never both copies and caps", () => {
      expect(pools).toBeDefined();
      expect(caps).toBeDefined();
      expect(placement?.copies).toBeUndefined();
    });

    it("app_poly = pods x (app pool + qualification) + one reserved", () => {
      const perPod = (pools?.app ?? 0) + QUALIFICATION_APP_CONNECTIONS;
      expect(caps?.app).toBe(SIMULTANEOUS_PODS * perPod + RESERVE);
    });

    it("service_poly = pods x (service + read + leader) + one reserved", () => {
      const perPod =
        (pools?.service ?? 0) + (pools?.read ?? 0) + LEADER_CONNECTIONS;
      expect(caps?.service).toBe(SIMULTANEOUS_PODS * perPod + RESERVE);
    });
  });

  it("only a dedicated row declares roleConnectionLimits, and never with copies", () => {
    for (const node of catalogs) {
      for (const [env, placement] of Object.entries(node.database ?? {})) {
        if (!placement.roleConnectionLimits) continue;
        expect(placement.tier, `${node.name}/${env}`).toBe("dedicated");
        expect(placement.copies, `${node.name}/${env}`).toBeUndefined();
        expect(placement.placement, `${node.name}/${env}`).toBeUndefined();
      }
    }
  });

  it("poly production keeps its audited cell: no lane role caps declared", () => {
    const poly = catalogs.find((c) => c.name === "poly");
    expect(poly?.database?.production?.roleConnectionLimits).toBeUndefined();
    expect(poly?.database?.production?.copies).toBeUndefined();
  });
});
