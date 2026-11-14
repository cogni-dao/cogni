// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/bootstrap-layer-boundaries`
 * Purpose: Validates bootstrap layer can import from adapters, ports, and shared only.
 * Scope: Tests bootstrap layer boundaries via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: Bootstrap may import from adapters/ports/shared; not core/features/app/components directly.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/bootstrap/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (bootstrap layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("Bootstrap layer boundaries", () => {
  it("allows bootstrap to import from adapters", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows bootstrap to import from ports", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows bootstrap to import from shared", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks bootstrap from importing features", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks bootstrap from importing core directly", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
      "nodes/operator/app/src/core/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks bootstrap from importing app", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks bootstrap from importing components", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/bootstrap/__arch_probes__",
      "nodes/operator/app/src/components/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
