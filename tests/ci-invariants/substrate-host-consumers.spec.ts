// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/substrate-host-consumers`
 * Purpose: Enforces RUNTIME_SUBSTRATE_FOLLOWS_THE_LANE (bug.5447) — compute control and
 *   runtime substrate are INDEPENDENT axes. `control_env_for` answers who pays/reconciles a
 *   workload and custodies its DB; the runtime substrate a workload dials (Temporal, Redis,
 *   LiteLLM, namespace, shared worker) derives from DEPLOYMENT_ENVIRONMENT only.
 * Scope: Static grep over the deploy actions/workflows/scripts that build a substrate host; does not execute them, resolve YAML, hit the network, or verify the host resolves.
 * Invariants:
 *   VM_HOST_FOR_ENV_NEVER_TAKES_A_CONTROL_ENV: `vm_host_for_env` is never called with a
 *     control-env-resolved value (CONTROL_ENV / SUBSTRATE_ENV / SECRETS_CONTROL_ENV /
 *     control_env_for output). Doing so (#2317 c98fd10a, #2324 64193509) routed candidate
 *     Akash lanes onto PRODUCTION Temporal/Redis/LiteLLM and forced the production worker
 *     to cross-poll candidate namespaces (bug.5212).
 *   MATERIALIZER_SUBSTRATE_IS_THE_LANE: the compute-workload materializer derives
 *     `substrateHost` from DEPLOYMENT_ENVIRONMENT itself.
 * Side-effects: IO (reads .github/, scripts/)
 * Links: scripts/ci/lib/appset-paths.sh (control_env_for), bug.5447, bug.5206, bug.5212
 * @public
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

const SEARCH_ROOTS = [".github/actions", ".github/workflows", "scripts/ci"];
const EXTS = new Set([".sh", ".yml", ".yaml"]);

/**
 * A control-env-resolved variable. `substrateHost` derived from one of these names the
 * CONTROLLING cluster's VM; the control env only pays/reconciles the workload and (where
 * applicable) custodies its DB — the DSNs already reach the workload as value-free
 * secretRefs resolved in the control cluster's vault. The runtime substrate the workload
 * dials is the LANE's: naming the control VM here submits a candidate lane's chat
 * workflows to production Temporal (25-29s chat on poly vs 4.7s on operator, bug.5447).
 */
const CONTROL_ENV_ARG =
  /vm_host_for_env\s+"?\$[({]?(SUBSTRATE_ENV|CONTROL_ENV|SECRETS_CONTROL_ENV|FLEET_CONTROL_ENV)\b|vm_host_for_env\s+"?\$\(\s*[^)]*control_env_for/;

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

describe("substrate host consumers (bug.5447)", () => {
  it("VM_HOST_FOR_ENV_NEVER_TAKES_A_CONTROL_ENV: runtime substrate derives from the lane", () => {
    const offences: string[] = [];
    for (const file of SEARCH_ROOTS.flatMap(walk)) {
      readFileSync(path.join(REPO_ROOT, file), "utf8")
        .split("\n")
        .forEach((text, i) => {
          const code = text.replace(/^\s*#\s?.*$/, "");
          if (CONTROL_ENV_ARG.test(code)) {
            offences.push(
              `  ${file}:${i + 1}\n    ${text.trim().slice(0, 140)}`
            );
          }
        });
    }
    expect(
      offences,
      `${offences.length} consumer(s) build the runtime substrate host from a CONTROL env. ` +
        `Compute control (pay/reconcile/DB custody, control_env_for) and runtime substrate ` +
        `(Temporal/Redis/LiteLLM/namespace/worker) are independent axes; the runtime substrate ` +
        `derives from DEPLOYMENT_ENVIRONMENT only (bug.5447).\n${offences.join("\n")}`
    ).toEqual([]);
  });

  it("MATERIALIZER_SUBSTRATE_IS_THE_LANE: the compute-workload materializer derives substrateHost from DEPLOYMENT_ENVIRONMENT", () => {
    const action = readFileSync(
      path.join(
        REPO_ROOT,
        ".github/actions/materialize-compute-workload/action.yml"
      ),
      "utf8"
    );
    expect(action).toMatch(
      /SUBSTRATE_HOST="\$\(cogni_vm_host_for_env "\$DEPLOYMENT_ENVIRONMENT"/
    );
  });
});
