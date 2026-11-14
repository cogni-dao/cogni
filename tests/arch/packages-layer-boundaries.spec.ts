// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/packages-layer-boundaries`
 * Purpose: Validates monorepo package boundaries (packages/, src/, services/ isolation).
 * Scope: Tests packages cannot import src/services, src cannot deep-import package internals. Does NOT test src/ hexagonal layer rules.
 * Invariants: packages/ is standalone; src/ imports packages via root only.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in packages/__arch_probes__/ and src/features/__arch_probes__/.
 * Links: .dependency-cruiser.cjs (monorepo boundary rules), https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
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

describe("Packages layer isolation (monorepo boundaries)", () => {
  describe("@cogni/aragon-osx", () => {
    it("allows internal imports", () => {
      const { exitCode, stderr } = runDepCruise(["packages/aragon-osx/src"]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("blocks importing from src/", () => {
      const { exitCode, stdout } = runDepCruise([
        "packages/aragon-osx/__arch_probes__",
        "nodes/operator/app/src/shared",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-packages-to-src-or-services");
    });
  });

  describe("@cogni/cogni-contracts", () => {
    it("allows internal imports", () => {
      const { exitCode, stderr } = runDepCruise([
        "packages/cogni-contracts/src",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("blocks importing from src/", () => {
      const { exitCode, stdout } = runDepCruise([
        "packages/cogni-contracts/__arch_probes__",
        "nodes/operator/app/src/shared",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-packages-to-src-or-services");
    });
  });

  describe("nodes/operator/app/src/ deep imports", () => {
    it("blocks deep-importing package internals", () => {
      const { exitCode, stdout } = runDepCruise([
        "nodes/operator/app/src/features/__arch_probes__/illegal-deep-package-import.ts",
        "packages/aragon-osx/src",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-deep-package-imports");
    });
  });
});
