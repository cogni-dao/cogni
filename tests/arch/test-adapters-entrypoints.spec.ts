// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/test-adapters-entrypoints`
 * Purpose: Validates test adapters entry point enforcement prevents internal module imports.
 * Scope: Tests entry point rules for @/adapters/test via dependency-cruiser. Does NOT test layer boundaries.
 * Invariants: Only index.ts can be imported; internal files blocked.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/bootstrap/__arch_probes__/ to test entry point enforcement.
 * Links: .dependency-cruiser.cjs (no-internal-test-adapter-imports rule), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runDepCruise(probeDirs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const baseLayers = probeDirs.map((path) => {
    const match = path.match(/^(src\/[^/]+)/);
    return match ? match[1] : path;
  });
  const includeOnly = [...probeDirs, ...baseLayers]
    .map((d) => `^${d}`)
    .join("|");

  const result = spawnSync(
    "pnpm",
    [
      "depcruise",
      ...probeDirs,
      "--config",
      ".dependency-cruiser.cjs",
      "--include-only",
      includeOnly,
      "--output-type",
      "err",
    ],
    {
      encoding: "utf-8",
      cwd: process.cwd(),
    }
  );

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe("Test adapters entry point enforcement", () => {
  it("allows importing from adapters/test index", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__/pass_entrypoint_imports_test_adapters_index.ts",
      "nodes/operator/app/src/adapters/test",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks internal test adapter file imports", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__/fail_entrypoint_imports_test_adapters_internal.ts",
      "nodes/operator/app/src/adapters/test",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("no-internal-test-adapter-imports");
  });
});
