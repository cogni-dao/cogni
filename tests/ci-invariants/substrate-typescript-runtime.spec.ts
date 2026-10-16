// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/substrate-typescript-runtime`
 * Purpose: Verify substrate jobs install the typed materializer runtime before mutation.
 * Scope: Workflow ordering and real owner-directory TypeScript resolution. Does not mutate infrastructure or access credentials/network.
 * Invariants: Both trusted tooling and exact app checkouts have frozen dependencies; caller cwd is not module authority.
 * Side-effects: IO (reads workflows and invokes one bounded local TypeScript expression)
 * Links: .github/workflows/candidate-flight.yml, .github/workflows/promote-and-deploy.yml, scripts/ci/secret-materialize.sh
 * @public
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const ROOT = path.resolve(__dirname, "../..");
type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };

describe("substrate TypeScript runtime", () => {
  for (const [file, job] of [
    ["candidate-flight.yml", "node-substrate"],
    ["candidate-flight.yml", "external-node-preflight"],
    ["promote-and-deploy.yml", "node-substrate"],
  ]) {
    it(`${file}/${job} installs runtime before substrate execution`, () => {
      const workflow = yaml.parse(
        readFileSync(path.join(ROOT, ".github/workflows", file), "utf8")
      ) as Workflow;
      const steps = workflow.jobs[job]?.steps ?? [];
      const substrateAt = steps.findIndex((step) =>
        step.run?.includes("run-node-substrate.sh")
      );
      expect(substrateAt).toBeGreaterThan(0);
      const before = steps.slice(0, substrateAt);
      expect(
        before.some(
          (step) =>
            step.uses?.startsWith("pnpm/action-setup@") &&
            step.with?.version === "9.12.2"
        )
      ).toBe(true);
      expect(
        before.some(
          (step) =>
            step.uses?.startsWith("actions/setup-node@") &&
            step.with?.["node-version"] === "22"
        )
      ).toBe(true);
      const installs = before.map((step) => step.run ?? "").join("\n");
      for (const owner of ["ci-src", "app-src"]) {
        expect(installs).toContain(
          `pnpm --dir ${owner} install --frozen-lockfile`
        );
      }
    });
  }

  it("resolves the real typed runtime from its owner outside the checkout", () => {
    const foreignCwd = mkdtempSync(path.join(tmpdir(), "substrate-runtime-"));
    try {
      const output = execFileSync(
        "pnpm",
        [
          "--dir",
          ROOT,
          "exec",
          "tsx",
          "-e",
          'import { z } from "zod"; process.stdout.write(z.literal("typed-runtime-ready").parse("typed-runtime-ready"))',
        ],
        {
          cwd: foreignCwd,
          timeout: 15_000,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
        }
      );
      expect(output).toBe("typed-runtime-ready");
    } finally {
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });
});
