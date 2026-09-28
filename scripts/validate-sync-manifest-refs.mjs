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
  const testParents = manifest.artifacts.filter(
    (a) => a.role === "test-parent"
  );
  if (testParents.length > 1) {
    fail(
      `more than one artifact declares \`role: test-parent\` (${testParents
        .map((a) => a.repo)
        .join(
          ", "
        )}) — scripts/ci/sync-test-parent.mjs syncs exactly one mirror`
    );
  }
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
    const nonEmpty = (key) => Array.isArray(d[key]) && d[key].length > 0;
    if (
      !nonEmpty("omit_from_artifact") &&
      !nonEmpty("artifact_only") &&
      !nonEmpty("content_may_differ")
    ) {
      errors.push(
        `divergences[${i}] for "${d.artifact}" must list at least one of omit_from_artifact, artifact_only or content_may_differ — empty divergence has no meaning`
      );
    }
    // A LITERAL path twin-listed in omit_from_artifact AND artifact_only is the v1 workaround for
    // "same file, both sides, different content" — and it suppresses the 🔴 missing signal as well
    // as the 🟡 different one, so a deleted canonical file goes unnoticed. `content_may_differ` is
    // the category for that now. A WILDCARD twin-listing is a different, legitimate shape: two
    // disjoint sets under one glob (each repo owns its own roster rows), where no specific path is
    // required, so it is left alone.
    for (const glob of d.omit_from_artifact ?? []) {
      if (!glob.includes("*") && (d.artifact_only ?? []).includes(glob)) {
        errors.push(
          `divergences[${i}] for "${d.artifact}": "${glob}" is twin-listed in omit_from_artifact AND artifact_only. Declare it in content_may_differ instead — twin-listing a literal path also hides its absence.`
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
