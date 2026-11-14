// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/app-layer-boundaries`
 * Purpose: Validates app layer can import from features, ports, bootstrap, contracts, components.
 * Scope: Tests app layer boundaries via dependency-cruiser. Does NOT test other layer boundaries.
 * Invariants: App may import from features/ports/bootstrap/contracts/components; not core/adapters directly.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/app/__arch_probes__/ to test boundary enforcement.
 * Links: .dependency-cruiser.cjs (app layer rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("App layer boundaries", () => {
  it("allows app to import from features", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows app to import from features components", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows app to import from bootstrap", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows app to import from contracts", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("allows app to import from components", () => {
    const { exitCode, stderr } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
    ]);
    if (exitCode !== 0) {
      console.error("STDERR:", stderr);
    }
    expect(exitCode).toBe(0);
  });

  it("blocks app from importing core directly", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
      "nodes/operator/app/src/core/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });

  it("blocks app from importing adapters directly", () => {
    const { exitCode, stdout } = runDepCruise([
      "nodes/operator/app/src/app/__arch_probes__",
      "nodes/operator/app/src/adapters/__arch_probes__",
    ]);
    if (exitCode === 0) {
      console.log("STDOUT:", stdout);
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not-in-allowed");
  });
});
