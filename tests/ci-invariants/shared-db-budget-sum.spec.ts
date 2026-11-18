// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/shared-db-budget-sum`
 * Purpose: Keep the sum of every shared-tier node's role caps under each env's Postgres ceiling.
 * Scope: Declarative catalog + budget-profile arithmetic; mirrors reconcile-node-substrate.sh scaling.
 * Invariants: Caps scale by catalog `copies` / profile `copies`; per env sum <= max_connections - reserve.
 * Side-effects: IO (reads infra/catalog and infra/database-budget-profiles.yaml)
 * Links: bug.5637, database-expert axiom 3, noisy-neighbor-database-architecture
 * @internal
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const ENVS = ["candidate-a", "preview", "production"] as const;
// Shared env Postgres runs the image default. Reserve covers superuser slots, the readonly
// exporter/Grafana role, support sessions and one migration burst outside node budgets.
const MAX_CONNECTIONS = 100;
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

const catalogs = readdirSync(path.join(root, "infra/catalog"))
  .filter((f) => f.endsWith(".yaml"))
  .map(
    (f) =>
      yaml.parse(readFileSync(path.join(root, "infra/catalog", f), "utf8")) as {
        name: string;
        database?: Record<
          string,
          { tier: string; budget_profile: string; copies?: number }
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

describe("shared database budget sum (bug.5637)", () => {
  it.each(ENVS)("%s role caps fit the env Postgres ceiling", (env) => {
    let sum = 0;
    for (const node of catalogs) {
      const placement = node.database?.[env];
      if (!placement || placement.tier !== "shared") continue;
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
    expect(sum).toBeLessThanOrEqual(MAX_CONNECTIONS - RESERVE);
  });

  it("node-template candidate-a caps cover both lanes x (live + spare)", () => {
    const nt = catalogs.find((c) => c.name === "node-template");
    const placement = nt?.database?.["candidate-a"];
    const profile = profiles[placement?.budget_profile ?? ""];
    expect(placement?.copies).toBe(4);
    expect(
      scaled(
        profile?.roles.app.connection_limit ?? 0,
        placement?.copies,
        profile?.copies
      )
    ).toBe(4);
    expect(
      scaled(
        profile?.roles.service.connection_limit ?? 0,
        placement?.copies,
        profile?.copies
      )
    ).toBe(8);
  });
});
