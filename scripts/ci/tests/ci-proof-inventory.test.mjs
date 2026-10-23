// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/tests/ci-proof-inventory`
 * Purpose: Prove split discovery preserves the full root test inventory and workflow failure gates.
 * Scope: Vitest file discovery and committed workflow reads. Does not execute native or Docker tests.
 * Invariants: Full inventory equals disjoint core plus native; all added native specs join automatically.
 * Side-effects: IO (read-only Vitest discovery subprocesses).
 * Links: .github/workflows/ci.yaml, scripts/vitest/vitest.native.config.mts
 * @internal
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const nativeConfig = "scripts/vitest/vitest.native.config.mts";
const nativeDirectory = "tests/ci-invariants/native/";
function list(...args) {
  return JSON.parse(
    execFileSync(
      "pnpm",
      ["exec", "vitest", "list", "--filesOnly", "--json", ...args],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    )
  )
    .map(({ file }) => file)
    .sort();
}
const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}`, "utf8")).jobs;

test("actual root inventory equals disjoint core/native inventories", () => {
  const full = list();
  const core = list("--exclude", `${nativeDirectory}**`);
  const native = list("--config", nativeConfig);
  const allNativeSpecs = readdirSync(nativeDirectory, { recursive: true })
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => resolve(nativeDirectory, name))
    .sort();
  for (const name of [
    "cadvisor-actor-coverage.spec.ts",
    "litellm-readiness-recovery.spec.ts",
    "openfga-readiness-recovery.spec.ts",
  ])
    assert.ok(native.includes(resolve(nativeDirectory, name)));
  assert.deepEqual(native, allNativeSpecs);
  assert.ok(native.every((file) => !core.includes(file)));
  assert.deepEqual([...core, ...native].sort(), full);
});

test("CI always aggregates split children while retaining bounded signed skips", () => {
  const jobs = workflow("ci.yaml");
  assert.equal(jobs.static.steps[0].with["fetch-depth"], 0);
  assert.deepEqual(jobs.unit.needs, [
    "env_manager_fast_path",
    "proof_plan",
    "unit_core",
    "shell",
    "native",
  ]);
  for (const gate of ["unit", "component"])
    assert.match(jobs[gate].if, /always\(\)/);
  for (const name of [
    "static",
    "unit",
    "component",
    "unit_core",
    "shell",
    "native",
    "component_core",
    "migrator",
  ])
    assert.ok(
      jobs[name].if.includes(
        "needs.env_manager_fast_path.result != 'success' || needs.env_manager_fast_path.outputs.eligible != 'true'"
      )
    );
  assert.deepEqual(jobs.component.needs, [
    "env_manager_fast_path",
    "component_core",
    "migrator",
  ]);
  assert.ok(
    jobs.native.steps.some((step) =>
      step.run?.includes(`--config ${nativeConfig}`)
    )
  );
  assert.equal(
    jobs.unit_core.steps.find((step) => step.name === "Unit + contract tests")
      .env.CI_NATIVE_SPLIT,
    "true"
  );
  assert.ok(
    jobs.shell.steps.some((step) =>
      step.run?.includes("bash scripts/ci/run-shell-tests.sh")
    )
  );
  assert.ok(
    jobs.shell.steps.some((step) =>
      step.run?.includes("check-jsonschema==0.37.1")
    )
  );
  // A false decision from an older event-base policy cannot skip native now.
  assert.ok(!jobs.native.if.includes("native_required"));
  assert.ok(!jobs.native.if.includes("proof_plan.outputs"));
  const plan = jobs.proof_plan.steps.find((step) => step.id === "plan").run;
  assert.ok(plan.includes('git show "$EVENT_BASE_SHA:$classifier"'));
  assert.ok(!plan.includes('git show "origin/main:'));
});

test("manifest always runs on ordinary events, independent of upstream result", () => {
  const gate = workflow("pr-build.yml").manifest;
  assert.match(gate.if, /always\(\)/);
  for (const name of ["resolve", "detect", "build"])
    assert.ok(!gate.if.includes(`needs.${name}.result`));
  assert.ok(
    gate.steps
      .find((step) => step.name === "Require coherent successful build plan")
      .run.includes("verify-manifest")
  );
});
