// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/features-layer-boundaries`
 * Purpose: Validates features layer can import from features, ports, core, shared, types, components only.
 * Scope: Tests features layer boundaries via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: Features may import from features/ports/core//types/components; not adapters/bootstrap.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/features/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (features layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("Features layer boundaries", () => {
  it("allows features to import from shared", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows features to import from components", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks features from importing adapters", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/features/__arch_probes__",
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks features from importing bootstrap", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/features/__arch_probes__",
      "nodes/operator/app/src/bootstrap/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks features from importing styles", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/features/__arch_probes__",
      "nodes/operator/app/src/styles/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
