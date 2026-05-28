#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-sync-manifest-refs`
 * Purpose: Cross-reference validation for .cogni/sync-manifest.yaml — every divergences[].artifact MUST be declared in artifacts[].
 * Scope: Cross-array references in the manifest; does NOT validate structure or types — those are delegated to check-jsonschema against .cogni/sync-manifest.schema.json (run in ci.yaml's unit job).
 * Invariants: spec.repo-sync-contract DECLARED_DIVERGENCE — every divergence entry must point at a declared artifact.
 * Side-effects: IO
 * Notes: Exits with non-zero code on validation failure.
 * Links: docs/spec/repo-sync-contract.md, .cogni/sync-manifest.schema.json, .github/workflows/ci.yaml
 * @public
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const MANIFEST = ".cogni/sync-manifest.yaml";

const fail = (msg) => {
  console.error(`\n✗ ${MANIFEST}: ${msg}`);
  process.exit(1);
};

const main = () => {
  const text = readFileSync(MANIFEST, "utf8");
  const manifest = parseYaml(text);
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    fail(
      "missing or empty `artifacts:` — structural validation (check-jsonschema in ci.yaml) should catch this first"
    );
  }
  if (!Array.isArray(manifest.divergences)) {
    fail("missing `divergences:` array");
  }

  const declaredArtifacts = new Set(manifest.artifacts.map((a) => a.repo));
  const errors = [];
  const seen = new Set();

  for (const [i, d] of manifest.divergences.entries()) {
    if (!declaredArtifacts.has(d.artifact)) {
      errors.push(
        `divergences[${i}].artifact "${d.artifact}" is not declared in artifacts[]`
      );
    }
    if (seen.has(d.artifact)) {
      errors.push(
        `divergences[${i}].artifact "${d.artifact}" appears more than once — merge entries`
      );
    }
    seen.add(d.artifact);
    const hasOmit =
      Array.isArray(d.omit_from_artifact) && d.omit_from_artifact.length > 0;
    const hasOnly =
      Array.isArray(d.artifact_only) && d.artifact_only.length > 0;
    if (!hasOmit && !hasOnly) {
      errors.push(
        `divergences[${i}] for "${d.artifact}" must list at least one of omit_from_artifact or artifact_only — empty divergence has no meaning`
      );
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
