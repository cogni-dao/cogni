#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-sync-manifest-refs`
 * Purpose: Cross-reference validation for .cogni/sync-manifest.yaml. Asserts every divergences[].path matches some scope[] glob and every divergences[].repos[] is a declared artifact.
 * Scope: Cross-array references in .cogni/sync-manifest.yaml; does NOT validate structure or types — those are delegated to check-jsonschema against .cogni/sync-manifest.schema.json.
 * Invariants: spec.repo-sync-contract DECLARED_DIVERGENCE — undeclared paths cannot be marked as divergences.
 * Side-effects: IO
 * Notes: Exits with non-zero code on validation failure.
 * Links: docs/spec/repo-sync-contract.md, .github/workflows/pr-build.yml
 * @public
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const MANIFEST = ".cogni/sync-manifest.yaml";

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

const globToRegex = (glob) => {
  // Minimal glob matcher: handles ** and * only. All other regex metachars
  // are escaped (including ?) so unsupported glob extensions degrade to
  // literal matching rather than silently changing semantics. Single-pass
  // walk avoids the \x00 sentinel pattern banned by biome.
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

const matchesAnyScope = (path, scopeGlobs) =>
  scopeGlobs.some((g) => globToRegex(g).test(path));

const fail = (msg) => {
  console.error(`\n✗ ${MANIFEST}: ${msg}`);
  process.exit(1);
};

const main = () => {
  const text = readFileSync(MANIFEST, "utf8");
  const manifest = parseYaml(text);
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    fail(
      "missing or empty `artifacts:` — structural validation (check-jsonschema) should catch this first"
    );
  }
  if (!Array.isArray(manifest.scope)) {
    fail("missing `scope:` array");
  }
  const declaredRepos = new Set(manifest.artifacts.map((a) => a.repo));
  const scope = manifest.scope;
  const errors = [];

  for (const [i, d] of (manifest.divergences ?? []).entries()) {
    if (!matchesAnyScope(d.path, scope)) {
      errors.push(
        `divergences[${i}].path "${d.path}" does not match any scope[] glob — declare it in scope or remove from divergences`
      );
    }
    for (const repo of d.repos) {
      if (!declaredRepos.has(repo)) {
        errors.push(
          `divergences[${i}].repos contains "${repo}" which is not declared in artifacts[]`
        );
      }
    }
  }

  if (errors.length) {
    console.error(`\n✗ ${MANIFEST} cross-reference errors:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✓ ${MANIFEST} cross-references valid`);
};

main();
