#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-sync-manifest-refs`
 * Purpose: Cross-reference validation for .cogni/sync-manifest.yaml. Asserts every divergences[].path matches some scope[] glob and every divergences[].repos[] is a declared artifact.
 * Scope: The cross-array references JSON Schema 2020-12 cannot express; structural validation is delegated to check-jsonschema against .cogni/sync-manifest.schema.json.
 * Invariants: spec.repo-sync-contract DECLARED_DIVERGENCE — undeclared paths cannot be marked as divergences.
 * Side-effects: process.exit(1) on validation failure.
 * Links: docs/spec/repo-sync-contract.md, .github/workflows/pr-build.yml
 * @public
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const MANIFEST = ".cogni/sync-manifest.yaml";

const globToRegex = (glob) => {
  // ** must be translated before * to avoid double-substitution.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${escaped}$`);
};

const matchesAnyScope = (path, scopeGlobs) =>
  scopeGlobs.some((g) => globToRegex(g).test(path));

const main = () => {
  const text = readFileSync(MANIFEST, "utf8");
  const manifest = parseYaml(text);
  const declaredRepos = new Set(manifest.artifacts.map((a) => a.repo));
  const scope = manifest.scope ?? [];
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
