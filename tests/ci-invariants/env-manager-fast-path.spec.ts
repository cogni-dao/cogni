// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/env-manager-fast-path.spec`
 * Purpose: Pins the fail-closed workflow wiring for the unified operator-change fast path.
 * Scope: Static YAML reads only; does not execute workflows or GitHub APIs. Classifier behavior is
 *   covered by its hermetic shell test.
 * Invariants:
 *   TRUSTED_CLASSIFIER: candidate code never decides whether its own heavy checks may be skipped.
 *   SKIP_WITHOUT_RUNNERS: eligible changes satisfy standard contexts as skipped jobs.
 *   INVALID_CLAIMS_RUN: classifier failure/ineligibility enters enforcement rather than skipping.
 * Side-effects: IO (reads .github/workflows/{ci.yaml,pr-build.yml})
 * Links: scripts/ci/classify-operator-change-fast-path.sh, docs/spec/merge-queue-config.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../..");

function workflow(name: string) {
  return parse(
    readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")
  ) as {
    jobs: Record<
      string,
      {
        if?: string;
        outputs?: Record<string, string>;
        steps?: Array<{ run?: string; with?: { "fetch-depth"?: number } }>;
      }
    >;
  };
}

const CLASSIFIER_FAILED = "needs.operator_change_fast_path.result != 'success'";
const NOT_ELIGIBLE =
  "needs.operator_change_fast_path.outputs.eligible != 'true'";

function expectFailClosedFastPathCondition(condition: string | undefined) {
  expect(condition).toContain(CLASSIFIER_FAILED);
  expect(condition).toContain(NOT_ELIGIBLE);
}

describe("signed operator-change workflow fast path", () => {
  it.each([
    "ci.yaml",
    "pr-build.yml",
  ] as const)("%s executes the classifier from trusted main with full git history", (name) => {
    const jobs = workflow(name).jobs;
    const classifier = jobs.operator_change_fast_path;
    expect(classifier.steps?.[0]?.with?.["fetch-depth"]).toBe(0);
    expect(
      classifier.steps?.some((step) =>
        step.run?.includes('git show "origin/main:$classifier" | bash')
      )
    ).toBe(true);
  });

  it("eligible CI skips all three application-heavy required jobs", () => {
    const jobs = workflow("ci.yaml").jobs;
    for (const name of ["static", "unit", "component"]) {
      expectFailClosedFastPathCondition(jobs[name]?.if);
    }
  });

  it("eligible PR builds skip image detection so manifest is satisfied downstream", () => {
    expectFailClosedFastPathCondition(workflow("pr-build.yml").jobs.detect?.if);
  });

  it("has exactly one classifier job and exposes invalid separately from disabled", () => {
    for (const name of ["ci.yaml", "pr-build.yml"] as const) {
      const jobs = workflow(name).jobs;
      expect(jobs.operator_change_fast_path).toBeDefined();
      expect(jobs.env_manager_fast_path).toBeUndefined();
      expect(jobs.node_birth_fast_path).toBeUndefined();
      expect(jobs.operator_change_fast_path.outputs?.invalid).toContain(
        "steps.classify.outputs.invalid"
      );
    }
  });
});
