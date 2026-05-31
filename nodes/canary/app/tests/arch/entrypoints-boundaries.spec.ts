// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/entrypoints-boundaries`
 * Purpose: Validates canonical entry point enforcement prevents internal module imports.
 * Scope: Tests entry point rules via dependency-cruiser. Does NOT test layer boundaries.
 * Invariants: Only index.ts/public.ts/services/components can be imported; internal files blocked.
 * Side-effects: IO (spawns depcruise subprocess)
 * Notes: Uses arch probes in src/*__arch_probes__/ to test entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), docs/spec/architecture.md
 * @public
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runDepCruise(probeFilesOrDirs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  // Extract caller layers from probe paths
  const callerLayers = probeFilesOrDirs.map((path) => {
    const match = path.match(/^(src\/[^/]+)/);
    return match ? match[1] : path;
  });

  // For entry point validation, include all base layers so dependency-cruiser
  // can see both the caller and the target of imports (e.g., app → ports/llm.port.ts)
  const allBaseLayers = [
    "src/core",
    "src/ports",
    "src/adapters",
    "src/features",
    "src/app",
    "src/bootstrap",
    "src/shared",
    "src/components",
  ];

  const includeOnly = [...probeFilesOrDirs, ...callerLayers, ...allBaseLayers]
    .map((d) => `^${d}`)
    .join("|");

  const result = spawnSync(
    "pnpm",
    [
      "depcruise",
      ...probeFilesOrDirs,
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

describe("Entry point enforcement", () => {
  describe("Canonical imports allowed", () => {
    it("allows importing from ports index", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/ports/__arch_probes__/pass_entrypoint_imports_index.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("allows importing from ports server (scheduler-core)", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/ports/__arch_probes__/pass_entrypoint_imports_server.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("allows importing from core public", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/core/__arch_probes__/pass_entrypoint_imports_public.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("allows importing from adapters server index", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/bootstrap/__arch_probes__/pass_entrypoint_imports_adapters_index.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("allows importing from features services", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/app/__arch_probes__/pass_entrypoint_imports_features_services.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });

    it("allows importing from features components", () => {
      const { exitCode, stderr } = runDepCruise([
        "src/app/__arch_probes__/pass_app_imports_features_components.ts",
      ]);
      if (exitCode !== 0) {
        console.error("STDERR:", stderr);
      }
      expect(exitCode).toBe(0);
    });
  });

  describe("Internal imports blocked", () => {
    it("blocks internal port file imports", () => {
      const { exitCode, stdout } = runDepCruise([
        "src/app/__arch_probes__/fail_entrypoint_imports_ports_internal.ts",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-internal-ports-imports");
    });

    // Skipped: shared core domain moved to @cogni/node-core package.
    // Internal import boundary is now enforced by package.json exports field,
    // not dep-cruiser filesystem rules. When nodes add their own core/ domain
    // files, re-add a probe targeting those node-local files.
    it.skip("blocks internal core file imports (enforced by package exports)", () => {
      // Probe removed: src/app/__arch_probes__/fail_entrypoint_imports_core_internal.ts
    });

    it("blocks internal adapter file imports", () => {
      const { exitCode, stdout } = runDepCruise([
        "src/bootstrap/__arch_probes__/fail_entrypoint_imports_adapters_internal.ts",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-internal-adapter-imports");
    });

    it("blocks features mappers imports", () => {
      const { exitCode, stdout } = runDepCruise([
        "src/app/__arch_probes__/fail_entrypoint_imports_features_mappers.ts",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-internal-features-imports");
    });

    it("blocks features utils imports", () => {
      const { exitCode, stdout } = runDepCruise([
        "src/app/__arch_probes__/fail_entrypoint_imports_features_utils.ts",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-internal-features-imports");
    });

    it("blocks features constants imports", () => {
      const { exitCode, stdout } = runDepCruise([
        "src/app/__arch_probes__/fail_entrypoint_imports_features_constants.ts",
      ]);
      if (exitCode === 0) {
        console.log("STDOUT:", stdout);
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("no-internal-features-imports");
    });
  });
});
