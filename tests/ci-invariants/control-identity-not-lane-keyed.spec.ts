// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/control-identity-not-lane-keyed`
 * Purpose: Enforces LANE_IS_NOT_CONTROL (story.5040) — the env a workload RUNS IN and the env that RECONCILES AND PAYS FOR it are different values, and a control-plane identity derived from the lane env silently targets a cluster or role that does not exist there. Three separate outages on 2026-09-16/17 were this one conflation in three files.
 * Scope: Static grep of scripts and workflows for control identities built from a lane variable; does not execute them, resolve OpenBao roles, or hit the network, and does not check the identity's permissions.
 * Invariants:
 *   WRITER_ROLE_IS_CONTROL_KEYED: an OpenBao writer role may not be built from the lane env.
 *   ACTUATOR_ADDRESS_IS_CONTROL_KEYED: the actuator address may not be built from the lane env.
 * Side-effects: IO (reads scripts/, .github/workflows/, infra/crossplane/)
 * Links: story.5040, scripts/ci/lib/appset-paths.sh, task.5132, bug.5206
 * @public
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SEARCH_ROOTS = ["scripts", ".github/workflows", "infra/crossplane"];
const EXTS = new Set([".sh", ".yml", ".yaml"]);

/** Lane-scoped variables — the env a workload RUNS IN. Never a control identity. */
const LANE_VAR =
  "(?:DEPLOY_ENVIRONMENT|DEPLOY_ENV|ENVIRONMENT|ENV_NAME|environment|env)";

/**
 * A control-plane IDENTITY built from a lane variable. Each alternative is a real
 * outage: the OpenBao writer role (bug.5206 — production's run minted
 * `candidate-a-writer`, which does not exist in production's vault, so seven keys
 * never materialised and the actuator was never called) and the actuator address
 * (task.5132 — a cross-namespace dial that #2300 had to add `actuatorNamespace` for).
 */
const OFFENCES: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    re: new RegExp(`role=['"]?\\$\\{?${LANE_VAR}\\}?-writer`),
    why: "OpenBao writer role built from the LANE env. The role lives in the cluster that RECONCILES the lane, not the lane itself — resolve the control env (bug.5206).",
  },
  {
    re: new RegExp(`akash-tx-actuator\\.\\$\\{?${LANE_VAR}\\}?[.\\s]`),
    why: "Actuator address built from the LANE env. The writer lives in the PAYING cluster's namespace — use the resolved actuatorNamespace (task.5132).",
  },
];

function walk(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (e === "node_modules") return [];
    const rel = path.join(dir, e);
    return statSync(path.join(REPO_ROOT, rel)).isDirectory()
      ? walk(rel)
      : EXTS.has(path.extname(e))
        ? [rel]
        : [];
  });
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly why: string;
  readonly text: string;
}

function scan(): Finding[] {
  const out: Finding[] = [];
  for (const file of SEARCH_ROOTS.flatMap(walk)) {
    const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((raw, i) => {
      const code = raw.replace(/^\s*#.*$/, "");
      if (!code.trim()) return;
      for (const o of OFFENCES) {
        if (o.re.test(code)) {
          out.push({
            file,
            line: i + 1,
            why: o.why,
            text: raw.trim().slice(0, 120),
          });
        }
      }
    });
  }
  return out;
}

describe("lane env is not a control identity (story.5040)", () => {
  it("LANE_IS_NOT_CONTROL: no control-plane identity is built from the lane env", () => {
    const found = scan();
    const report = found
      .map((f) => `  ${f.file}:${f.line}\n    ${f.text}\n    -> ${f.why}`)
      .join("\n");
    expect(
      found,
      `${found.length} control identit(ies) derived from the LANE env.\n\n` +
        `The env a workload RUNS IN and the env that RECONCILES AND PAYS FOR it are ` +
        `different values. An identity keyed on the lane resolves to a role or address ` +
        `that does not exist in the reconciling cluster, and it fails CLOSED and SILENT — ` +
        `no lease, no error anyone reads. This single conflation caused three separate ` +
        `failures in three files on 2026-09-16/17 (AppSet path, actuator address, vault ` +
        `writer role). Resolve the CONTROL env; keep the LANE env for the path only.\n` +
        `${report}`
    ).toEqual([]);
  });
});
