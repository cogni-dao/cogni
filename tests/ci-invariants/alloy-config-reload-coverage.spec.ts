// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/alloy-config-reload-coverage`
 * Purpose: Prove every runtime Alloy service has its own config hashed and its own container restarted, so a merged collector-config change cannot deploy green and stay inert.
 * Scope: Cross-reads the runtime compose file and deploy-infra.sh as text; does not run a deploy, reach a VM, or start a container.
 * Invariants:
 *   - EVERY_ALLOY_SERVICE_RELOADS: each alloy service in the runtime compose is named in
 *     a restart gate with the exact config path it mounts.
 *   - DISTINCT_HASH_STATE: no two services share a hash file, or one masks the other.
 * Side-effects: none
 * Links: bug.5420, bug.5416, infra/compose/runtime/AGENTS.md
 * @public
 *
 * WHY THIS EXISTS. `docker compose up -d` does not recreate a container when only the
 * CONTENT of a bind-mounted config changes — compose compares the service spec, so an
 * unchanged spec means no recreate. The deploy therefore needs an explicit per-service
 * content hash and restart, and it had one for exactly one of the two Alloy services.
 *
 * Measured 2026-10-09: production infra-reconcile 37988564314 reported
 * `completed/success` and `Alloy config unchanged ... no restart needed`, while
 * `{env="production",service="kubernetes-events",namespace="default"}` sat at a 6h hard
 * zero — the allowlist from #2648 was on the box, unloaded. A flat metric reads as
 * "nothing happened", not as "we never applied it", which is what makes this class of
 * gap expensive: three deploys reported success over it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMPOSE = path.join(
  REPO_ROOT,
  "infra/compose/runtime/docker-compose.yml"
);
const DEPLOY_INFRA = path.join(REPO_ROOT, "scripts/ci/deploy-infra.sh");

const compose = readFileSync(COMPOSE, "utf8");
const deployInfra = readFileSync(DEPLOY_INFRA, "utf8");

/**
 * Every top-level service whose name mentions alloy, paired with the alloy config
 * filenames its block references. Read as text rather than parsed as YAML so the test
 * has no dependency on a yaml library being present in this project.
 */
function alloyServices(): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();
  const lines = compose.split("\n");
  let current: string | null = null;

  for (const line of lines) {
    const service = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (service) {
      current = service[1].includes("alloy") ? service[1] : null;
      if (current) found.set(current, []);
      continue;
    }
    if (!current) continue;
    for (const match of line.matchAll(/alloy-config[\w.-]*\.alloy/g)) {
      const configs = found.get(current);
      if (configs && !configs.includes(match[0])) configs.push(match[0]);
    }
  }
  return found;
}

/** The (config path, service, hash path) triples deploy-infra.sh actually wires up. */
function restartGates(): readonly {
  config: string;
  service: string;
  hashPath: string;
}[] {
  const call =
    /restart_alloy_service_if_config_changed\s*\\?\s*\n?\s*(\S+)\s*\\?\s*\n?\s*(\S+)\s*\\?\s*\n?\s*(\S+)/g;
  return (
    [...deployInfra.matchAll(call)]
      .map((m) => ({ config: m[1], service: m[2], hashPath: m[3] }))
      // The function's own definition line matches too (`...changed() {`); a gate is a
      // call, identified by an absolute config path as its first argument.
      .filter((gate) => gate.config.startsWith("/"))
  );
}

describe("alloy config reload coverage (bug.5420)", () => {
  it("the compose file still has more than one alloy service", () => {
    // If this ever drops to one, the invariant below becomes vacuous rather than false.
    const services = alloyServices();
    expect(services.size).toBeGreaterThan(1);
    for (const [service, configs] of services) {
      expect(configs, `${service} mounts no alloy config`).not.toHaveLength(0);
    }
  });

  it("EVERY_ALLOY_SERVICE_RELOADS: each alloy service is restarted on its own config change", () => {
    const gates = restartGates();
    expect(gates.length).toBeGreaterThan(0);

    for (const [service, configs] of alloyServices()) {
      const gate = gates.find((g) => g.service === service);
      expect(
        gate,
        `${service} mounts ${configs.join(", ")} but no restart gate names it — a config edit would deploy green and never load`
      ).toBeDefined();
      // The gate must watch the config this service actually mounts, not a sibling's.
      expect(
        configs.some((config) => gate?.config.endsWith(config)),
        `${service} restart gate watches ${gate?.config}, but the service mounts ${configs.join(", ")}`
      ).toBe(true);
    }
  });

  it("DISTINCT_HASH_STATE: no two services share hash state", () => {
    const gates = restartGates();
    const hashPaths = gates.map((g) => g.hashPath);

    expect(new Set(hashPaths).size).toBe(hashPaths.length);
    // One hash path must not be a prefix-extension of another's directory entry in a way
    // that lets a single write satisfy both.
    expect(new Set(gates.map((g) => g.service)).size).toBe(gates.length);
  });
});
