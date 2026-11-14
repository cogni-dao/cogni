// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/shared-layer-boundaries`
 * Purpose: Validates shared layer cannot import from features or other upper layers.
 * Scope: Tests shared layer boundaries via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: Shared may only import from /types; any import from features/app must fail.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/shared/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (shared layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runDepCruise(probeDirs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const includeOnly = probeDirs.map((d) => `^${d}`).join("|");

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

describe("Shared layer boundaries", () => {
  it("blocks shared from importing features", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/shared/__arch_probes__",
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
