#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/lib/sync-policy`
 * Purpose: The ONE reader of `.cogni/sync-manifest.yaml`'s divergence policy — compiles a repo's
 *   `exclude`/`omit_from_artifact`/`artifact_only`/`content_may_differ` globs into a single
 *   decision function that classifies any path as mirrored, content-free, hub-only or artifact-only.
 * Scope: Pure policy. Both consumers import it: `detect-sync-drift.mjs` (surfacing) and
 *   `sync-test-parent.mjs` (refresh). A second hand-rolled matcher is exactly the drift class this
 *   repo keeps paying for, so there is deliberately only one.
 * Invariants:
 *   - DEFAULT_DENY_DIVERGENCE (spec.repo-sync-contract): a path is mirrored 1:1 unless a declared
 *     glob says otherwise, so a newly added canonical path is in scope the moment it lands.
 *   - CONTENT_MAY_DIFFER_WINS: `content_may_differ` takes precedence over `omit_from_artifact` —
 *     it re-requires the control-plane paths nested inside a broad roster omission, and it
 *     suppresses the CONTENT check only. Absence is still drift, which is what keeps a generated
 *     canonical path from going silently missing.
 * Side-effects: IO (reads the manifest file passed in).
 * Links: .cogni/sync-manifest.yaml, .cogni/sync-manifest.schema.json, docs/spec/repo-sync-contract.md
 * @public
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const REGEX_META = new Set([
  ".",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
]);

/** `**` spans separators, `*` does not — the same subset every other Cogni glob list uses. */
export const globToRegex = (glob) => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (REGEX_META.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
};

const compile = (globs) => (globs ?? []).map(globToRegex);
const matches = (path, regexes) => regexes.some((re) => re.test(path));

/** Parse the manifest once. */
export const readManifest = (manifestPath) =>
  parseYaml(readFileSync(manifestPath, "utf8"));

/**
 * Compile the policy for ONE artifact.
 *
 * Returns:
 *   - `excluded(path)`      — global junk; invisible to both sides.
 *   - `hubDisposition(path)`— for a hub path: `mirror` | `content_free` | `hub_only`.
 *   - `isArtifactOnlyDeclared(path)` — for an artifact path the hub does not require.
 *   - `onMissing`           — `report` (drift is data) or `fail` (exit non-zero).
 *   - `role`                — `fork` | `test-parent`.
 */
export const compileArtifactPolicy = (manifest, repo) => {
  const spec = manifest.artifacts.find((a) => a.repo === repo);
  if (!spec)
    throw new Error(`artifact '${repo}' is not declared in artifacts[]`);
  const divergence =
    (manifest.divergences ?? []).find((d) => d.artifact === repo) ?? {};

  const excludeRes = compile(manifest.exclude);
  const omitRes = compile(divergence.omit_from_artifact);
  const onlyRes = compile(divergence.artifact_only);
  const contentFreeRes = compile(divergence.content_may_differ);

  return {
    repo,
    role: spec.role ?? "fork",
    visibility: spec.visibility,
    onMissing: spec.on_missing ?? "report",
    reason: divergence.reason ?? null,
    excluded: (path) => matches(path, excludeRes),
    /** CONTENT_MAY_DIFFER_WINS is encoded here and nowhere else. */
    hubDisposition: (path) => {
      if (matches(path, contentFreeRes)) return "content_free";
      if (matches(path, omitRes)) return "hub_only";
      return "mirror";
    },
    isArtifactOnlyDeclared: (path) => matches(path, onlyRes),
  };
};
