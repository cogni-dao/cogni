// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/appset-path-consumers`
 * Purpose: Enforces APPSET_PATH_IS_CONTROL_ENV_SCOPED (story.5040, bug.5204) — an AppSet lives under the cluster that RECONCILES it, not the env it names, so no consumer may build that path from the env alone. task.5132 moved akash non-prod lanes to appsets/production/ and several readers kept the old convention, breaking the first poly mint.
 * Scope: Static grep over workflows, scripts and operator source; does not execute them, resolve YAML, or hit the network, and does not check the AppSet's content.
 * Invariants:
 *   NO_ENV_KEYED_APPSET_PATH: a consumer may not build the AppSet path from the env alone.
 *   RESOLVER_IS_SINGLE_DEFINITION: only the renderer may spell the layout, via control_env_for.
 * Side-effects: IO (reads .github/workflows, scripts/ci, nodes/operator/app/src)
 * Links: scripts/ci/render-node-appset.sh (control_env_for), story.5040, bug.5204, task.5132
 * @public
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * The ONE place allowed to spell the layout — it defines `control_env_for`, the rule every
 * other consumer must ask rather than restate. Its TS twin is tracked by bug.5204.
 */
const RESOLVER = "scripts/ci/render-node-appset.sh";

const SEARCH_ROOTS = [
  ".github/workflows",
  "scripts/ci",
  "nodes/operator/app/src",
];
const EXTS = new Set([".sh", ".yml", ".yaml", ".ts"]);

/** `appsets/<something>/` where <something> is an env expression, not a resolved control env. */
const ENV_KEYED =
  /appsets\/\$\{?\{?\s*(?:DEPLOY_)?(?:ENVIRONMENT|env|ENV)\b[^/]*\/|appsets\/(?:candidate-a|preview)\//;

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
    if (e === "node_modules" || e.startsWith(".next")) return [];
    return statSync(path.join(REPO_ROOT, rel)).isDirectory()
      ? walk(rel)
      : EXTS.has(path.extname(e))
        ? [rel]
        : [];
  });
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findOffences(): Offence[] {
  const out: Offence[] = [];
  for (const file of SEARCH_ROOTS.flatMap(walk)) {
    if (file === RESOLVER) continue;
    // Control-plane app-of-apps legitimately scope a source path to their OWN cluster's dir.
    if (file.includes("argocd/control-plane/")) continue;
    const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const code = text.replace(/^\s*(?:#|\/\/|\*)\s?.*$/, "");
      if (!code || !ENV_KEYED.test(code)) return;
      if (!/applicationset|kustomization/i.test(code)) return;
      out.push({ file, line: i + 1, text: text.trim().slice(0, 140) });
    });
  }
  return out;
}

describe("appset path consumers (story.5040 / bug.5204)", () => {
  it("NO_ENV_KEYED_APPSET_PATH: every consumer resolves the control env", () => {
    const offences = findOffences();
    const report = offences
      .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
      .join("\n");
    expect(
      offences,
      `${offences.length} consumer(s) build the AppSet path from the ENV instead of the ` +
        `CONTROL env. An akash node's non-production lane is reconciled by the PRODUCTION ` +
        `cluster (task.5132), so its AppSet lives under appsets/production/ — these look in ` +
        `the wrong directory and fail only for that case, which is every real node's test and ` +
        `preview lane. Resolve it the way ${RESOLVER}'s control_env_for does.\n${report}`
    ).toEqual([]);
  });
});
