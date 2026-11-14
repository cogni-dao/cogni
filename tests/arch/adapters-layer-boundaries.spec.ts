// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/adapters-layer-boundaries`
 * Purpose: Validates adapters layer can import from ports, core, shared only.
 * Scope: Tests adapters layer boundaries via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: Adapters may import from ports/core/shared; not features/app/components/bootstrap.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/adapters/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (adapters layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("Adapters layer boundaries", () => {
  it("allows adapters to import from ports", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows adapters to import from core", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows adapters to import from shared", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks adapters from importing features", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
      "nodes/operator/app/src/features/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks adapters from importing app", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks adapters from importing components", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
      "nodes/operator/app/src/components/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks adapters from importing bootstrap", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/adapters/__arch_probes__",
      "nodes/operator/app/src/bootstrap/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
