// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/substrate-host-consumers`
 * Purpose: Enforces SUBSTRATE_HOST_IS_CONTROL_ENV_SCOPED (bug.5206) — the shared substrate a
 *   workload dials belongs to the cluster that RECONCILES the lane, not the lane it is named
 *   after, so no consumer may derive it from the workload env alone.
 * Scope: Static grep over the deploy actions/workflows/scripts that build a substrate host.
 *   Does not execute them, resolve YAML, or hit the network.
 * Invariants:
 *   VM_HOST_FOR_ENV_TAKES_A_RESOLVED_ENV: `vm_host_for_env` is never called with a raw
 *     workload-env variable; its first argument must be a control-env-resolved value.
 * Side-effects: IO (reads .github/, scripts/)
 * Links: scripts/ci/lib/appset-paths.sh (control_env_for), bug.5206, task.5132
 * @public
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The one place allowed to spell the rule. */
const RESOLVER = "scripts/ci/lib/appset-paths.sh";

const SEARCH_ROOTS = [".github/actions", ".github/workflows", "scripts/ci"];
const EXTS = new Set([".sh", ".yml", ".yaml"]);

/**
 * A raw workload-env variable. `substrateHost` derived from one of these names the LANE's VM;
 * for an akash node's non-production lane the substrate lives on the CONTROL env's VM, and
 * mixing them gives the workload production's Postgres and the lane's Temporal — half a
 * substrate, which is worse than none because it boots.
 */
const RAW_ENV_ARG =
  /vm_host_for_env\s+"?\$\{?(DEPLOYMENT_ENVIRONMENT|DEPLOY_ENVIRONMENT|DEPLOY_ENV|ENVIRONMENT)\b/;

function walk(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const rel = path.join(dir, e);
    if (e === "node_modules") return [];
    return statSync(path.join(REPO_ROOT, rel)).isDirectory()
      ? walk(rel)
      : EXTS.has(path.extname(e))
        ? [rel]
        : [];
  });
}

describe("substrate host consumers (bug.5206)", () => {
  it("VM_HOST_FOR_ENV_TAKES_A_RESOLVED_ENV: never the raw workload env", () => {
    const offences: string[] = [];
    for (const file of SEARCH_ROOTS.flatMap(walk)) {
      if (file === RESOLVER) continue;
      readFileSync(path.join(REPO_ROOT, file), "utf8")
        .split("\n")
        .forEach((text, i) => {
          const code = text.replace(/^\s*#\s?.*$/, "");
          if (RAW_ENV_ARG.test(code)) {
            offences.push(`  ${file}:${i + 1}\n    ${text.trim().slice(0, 140)}`);
          }
        });
    }
    expect(
      offences,
      `${offences.length} consumer(s) build the substrate host from the WORKLOAD env. An akash ` +
        `node's non-production lane is reconciled by the PRODUCTION cluster (task.5132) and its ` +
        `DSNs are composed against that cluster's VM, so naming the lane's VM here gives the ` +
        `workload production's Postgres and the lane's Temporal/Redis/LiteLLM — half a ` +
        `substrate, which boots and then fails. Resolve it the way ${RESOLVER}'s ` +
        `control_env_for does.\n${offences.join("\n")}`
    ).toEqual([]);
  });
});
