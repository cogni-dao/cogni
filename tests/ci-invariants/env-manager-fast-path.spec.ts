// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/env-manager-fast-path.spec`
 * Purpose: Pins the fail-closed workflow wiring for the signed env-membership fast path.
 * Scope: Static YAML reads only; does not execute workflows or GitHub APIs. Classifier behavior is
 *   covered by its hermetic shell test.
 * Invariants:
 *   TRUSTED_CLASSIFIER: candidate code never decides whether its own heavy checks may be skipped.
 *   SKIP_WITHOUT_RUNNERS: eligible changes satisfy standard contexts as skipped jobs.
 *   INVALID_CLAIMS_RUN: classifier failure/ineligibility enters enforcement rather than skipping.
 * Side-effects: IO (reads .github/workflows/{ci.yaml,pr-build.yml})
 * Links: scripts/ci/classify-env-manager-fast-path.sh, docs/spec/merge-queue-config.md
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
        steps?: Array<{ run?: string; with?: { "fetch-depth"?: number } }>;
      }
    >;
  };
}

const FAIL_CLOSED_SKIP =
  "needs.env_manager_fast_path.result != 'success' || needs.env_manager_fast_path.outputs.eligible != 'true'";

describe("signed env-manager workflow fast path", () => {
  it.each([
    "ci.yaml",
    "pr-build.yml",
  ] as const)("%s executes the classifier from trusted main with full git history", (name) => {
    const jobs = workflow(name).jobs;
    const classifier = jobs.env_manager_fast_path;
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
      expect(jobs[name]?.if).toContain(FAIL_CLOSED_SKIP);
    }
  });

  it("eligible PR builds skip image detection so manifest is satisfied downstream", () => {
    expect(workflow("pr-build.yml").jobs.detect?.if).toContain(
      FAIL_CLOSED_SKIP
    );
  });

  it("keeps schema and deterministic render proof in the CI classifier job", () => {
    const runs = workflow("ci.yaml")
      .jobs.env_manager_fast_path.steps?.map((step) => step.run ?? "")
      .join("\n");
    expect(runs).toContain("check-jsonschema");
    expect(runs).toContain("render-scheduler-worker-endpoints.sh --check");
    expect(runs).toContain("render-node-appset.sh --check");
    expect(runs).toContain("render-node-overlays.sh --check");
  });
});
