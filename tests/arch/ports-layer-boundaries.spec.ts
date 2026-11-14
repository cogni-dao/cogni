// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/ports-layer-boundaries`
 * Purpose: Validates ports layer can import from ports, core, and types only.
 * Scope: Tests ports layer isolation via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: Ports may import from ports/core/types; any import from features/adapters/app must fail.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/ports/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (ports layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("Ports layer boundaries", () => {
  it("allows ports to import from core", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/ports/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks ports from importing adapters", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/ports/__arch_probes__",
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks ports from importing features", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/ports/__arch_probes__",
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
