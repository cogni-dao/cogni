// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/lint/biome/meta`
 * Purpose: Meta-tests enforcing Biome test infrastructure invariants.
 * Scope: Validates no import drift, no accidental unskips, filename parity. Does NOT test linting rules.
 * Invariants: Biome specs must not import runEslint; only migrated rules may be unskipped.
 * Side-effects: none
 * Notes: Anti-drift safeguards for test migration hygiene.
 * Links: https://cognidao.org/knowledge/operator-lint-toolchain
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const biomeDir = path.resolve(__dirname);
const eslintDir = path.resolve(__dirname, "../eslint");

// Hardcoded allowlist of specs allowed to have unskipped tests
// Update this when migrating a new rule per https://cognidao.org/knowledge/operator-lint-toolchain
const ALLOWED_UNSKIPPED_SPECS = new Set([
  "canary.spec.ts", // Commit 2B: noDefaultExport
  "process-env.spec.ts", // Commit 3: noProcessEnv
  "type-imports.spec.ts", // Commit 4: useImportType
  "unused-vars.spec.ts", // Commit 5: noUnusedVariables + noUnusedImports
  "no-explicit-any.spec.ts", // Commit 6: noExplicitAny
  "meta.spec.ts", // Meta-tests (always active)
]);

describe("Biome Test Infrastructure Meta-Tests", () => {
  it("no biome spec imports runEslint", () => {
    const biomeSpecs = readdirSync(biomeDir).filter((f) =>
      f.endsWith(".spec.ts")
    );

    for (const spec of biomeSpecs) {
      const content = readFileSync(path.join(biomeDir, spec), "utf8");

      // Check for runEslint import (both quote styles)
      const hasRunEslintImport = /from\s+['"]\.\/runEslint['"]/.test(content);

      expect(
        hasRunEslintImport,
        `${spec} imports runEslint but should import runBiome`
      ).toBe(false);
    }
  });

  it("every biome spec (except meta) imports runBiome", () => {
    const biomeSpecs = readdirSync(biomeDir).filter(
      (f) => f.endsWith(".spec.ts") && f !== "meta.spec.ts"
    );

    for (const spec of biomeSpecs) {
      const content = readFileSync(path.join(biomeDir, spec), "utf8");

      // Check for runBiome import
      const hasRunBiomeImport = /from\s+['"]\.\/runBiome['"]/.test(content);

      expect(hasRunBiomeImport, `${spec} must import from './runBiome'`).toBe(
        true
      );
    }
  });

  it("no specs use .only (prevents accidental test isolation)", () => {
    const biomeSpecs = readdirSync(biomeDir).filter((f) =>
      f.endsWith(".spec.ts")
    );

    for (const spec of biomeSpecs) {
      const content = readFileSync(path.join(biomeDir, spec), "utf8");

      // Check for describe.only or it.only usage
      const hasOnly = /\b(describe|it)\.only\s*\(/.test(content);

      expect(hasOnly, `${spec} uses .only - remove before committing`).toBe(
        false
      );
    }
  });

  it("non-allowlisted specs have exactly one top-level describe.skip", () => {
    const biomeSpecs = readdirSync(biomeDir).filter((f) =>
      f.endsWith(".spec.ts")
    );

    for (const spec of biomeSpecs) {
      if (ALLOWED_UNSKIPPED_SPECS.has(spec)) {
        continue; // Skip allowlisted specs
      }

      const content = readFileSync(path.join(biomeDir, spec), "utf8");

      // Count describe.skip occurrences (should be exactly 1 for non-migrated specs)
      const describeSkipMatches = content.match(/\bdescribe\.skip\s*\(/g);
      const describeSkipCount = describeSkipMatches?.length ?? 0;

      // Also ensure there are no unskipped top-level describe blocks
      const unskippedDescribe =
        /\bdescribe\s*\(/.test(content) &&
        !/\bdescribe\.skip\s*\(/.test(content);

      expect(
        describeSkipCount === 1 && !unskippedDescribe,
        `${spec} must have exactly one top-level describe.skip(...) - found ${describeSkipCount}`
      ).toBe(true);
    }
  });

  it("biome and eslint spec filenames match 1:1 (excluding meta/canary/arch tests)", () => {
    const archTests = new Set([
      "meta.spec.ts",
      "canary.spec.ts",
      "entry-points.spec.ts",
      "adapters.spec.ts",
      "bootstrap.spec.ts",
      "boundaries.spec.ts",
      "contracts.spec.ts",
      "features-boundaries.spec.ts",
      "imports.spec.ts",
      "vendor-sdk-imports.spec.ts",
    ]);

    const biomeSpecs = readdirSync(biomeDir)
      .filter((f) => f.endsWith(".spec.ts") && !archTests.has(f))
      .sort();

    const eslintSpecs = readdirSync(eslintDir)
      .filter((f) => f.endsWith(".spec.ts"))
      .sort();

    // Every ESLint spec should have a corresponding Biome spec
    for (const eslintSpec of eslintSpecs) {
      expect(
        biomeSpecs.includes(eslintSpec),
        `ESLint has ${eslintSpec} but Biome directory is missing it`
      ).toBe(true);
    }

    // Every Biome spec should have a corresponding ESLint spec
    for (const biomeSpec of biomeSpecs) {
      expect(
        eslintSpecs.includes(biomeSpec),
        `Biome has ${biomeSpec} but ESLint directory is missing it`
      ).toBe(true);
    }
  });
});
