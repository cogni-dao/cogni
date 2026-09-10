// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-manifest-source`
 * Purpose: Pins pre-merge manifest provenance for candidate-a node-ref flights.
 * Scope: Static assertions over candidate-flight.yml; does not execute GitHub Actions or deploy.
 * Invariants:
 *   CANDIDATE_MANIFESTS_FOLLOW_IN_REPO_SOURCE: an in-repo node-ref flight uses
 *     source_sha as head_sha, so infra/k8s is materialized from the exact
 *     flighted revision rather than the workflow's main revision.
 *   REMOTE_NODE_SOURCE_STAYS_SEPARATE: a remote node's source SHA is not used
 *     as a parent-monorepo checkout ref.
 * Side-effects: IO (reads .github/workflows/candidate-flight.yml)
 * Links: docs/spec/ci-cd.md axioms 17-20, docs/spec/node-ci-cd-contract.md artifact contract
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/candidate-flight.yml"),
  "utf8"
);

interface WorkflowStep {
  name?: string;
  if?: string;
  env?: Record<string, unknown>;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  outputs?: Record<string, unknown>;
  steps: WorkflowStep[];
}

const parsed = yaml.parse(WORKFLOW) as {
  jobs: Record<string, WorkflowJob>;
};

function namedStep(jobName: string, stepName: string): WorkflowStep {
  const job = parsed.jobs[jobName];
  expect(job, `${jobName} job must exist`).toBeDefined();
  const step = job.steps.find(({ name }) => name === stepName);
  expect(step, `${jobName}/${stepName} step must exist`).toBeDefined();
  return step as WorkflowStep;
}

describe("candidate-a manifest source", () => {
  it("selects the flighted source SHA for an in-repo node-ref", () => {
    const meta = namedStep("decide", "Resolve PR metadata").run;

    expect(meta).toBeTypeOf("string");
    expect(meta).toContain('CATALOG="infra/catalog/${NODE_SLUG}.yaml"');
    expect(meta).toMatch(
      /SOURCE_REPO=\$\(yq -N '\.source_repo \/\/ ""' "\$CATALOG"\)\s+if \[ -z "\$SOURCE_REPO" \]; then[\s\S]*?HEAD_SHA="\$NODE_SOURCE_SHA"/
    );
  });

  it("does not use a child-repo SHA as the parent manifest ref", () => {
    const meta = namedStep("decide", "Resolve PR metadata").run;

    expect(meta).toBeTypeOf("string");
    expect(meta).toMatch(
      /if \[ -z "\$SOURCE_REPO" \]; then[\s\S]*?HEAD_SHA="\$NODE_SOURCE_SHA"[\s\S]*?else[\s\S]*?HEAD_SHA="\$\{\{ github\.sha \}\}"/
    );
  });

  it("checks out candidate manifest inputs from the resolved head SHA", () => {
    expect(namedStep("decide", "Checkout app source").with?.ref).toBe(
      "${{ steps.meta.outputs.head_sha }}"
    );
    expect(namedStep("flight", "Checkout app source").with?.ref).toBe(
      "${{ needs.decide.outputs.head_sha }}"
    );
    expect(WORKFLOW).toContain(
      "rsync -a --delete app-src/infra/k8s/base/ deploy-branch/infra/k8s/base/"
    );
    expect(WORKFLOW).toContain(
      '"app-src/infra/k8s/overlays/candidate-a/${NODE}/"'
    );
  });

  it("preserves the deployed digest until shape and artifact can promote atomically", () => {
    const prepare = namedStep(
      "prepare-substrate-deploy-branch",
      "Prepare deploy branch shape"
    ).run;

    expect(prepare).toBeTypeOf("string");
    const snapshot = prepare?.indexOf("PRESERVED_IMAGE_REF=$(\n");
    const overlaySync = prepare?.indexOf(
      '"../app-src/infra/k8s/overlays/candidate-a/${NODE}/"'
    );
    const restore = prepare?.indexOf("promote-k8s-image.sh --no-commit");
    const commit = prepare?.indexOf(
      'git commit -m "candidate-flight ${NODE}: prepare substrate shape"'
    );

    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(overlaySync).toBeGreaterThan(snapshot ?? -1);
    expect(restore).toBeGreaterThan(overlaySync ?? -1);
    expect(commit).toBeGreaterThan(restore ?? -1);
    expect(prepare).toContain('[[ "$PRESERVED_IMAGE_REF" == *"@sha256:"* ]]');
    expect(prepare).toContain('--digest "$PRESERVED_IMAGE_REF"');
  });

  it("reports commit status on the parent source SHA only when it owns that SHA", () => {
    const decide = parsed.jobs.decide;
    const meta = namedStep("decide", "Resolve PR metadata").run;
    const pending = namedStep(
      "decide",
      "Report pending candidate-flight status"
    );
    const terminal = namedStep(
      "report-status",
      "Report terminal candidate-flight status"
    );
    const sourceRepoBranches = meta?.match(
      /if \[ -z "\$SOURCE_REPO" \]; then(?<inRepo>[\s\S]*?)\n {2}else(?<remote>[\s\S]*?)\n {2}fi\n {2}IMAGE_TAG=/
    );

    expect(decide.outputs?.commit_status_sha).toBe(
      "${{ steps.meta.outputs.commit_status_sha }}"
    );
    expect(meta).toBeTypeOf("string");
    expect(meta).toContain('COMMIT_STATUS_SHA=""');
    expect(sourceRepoBranches?.groups?.inRepo).toContain(
      'HEAD_SHA="$NODE_SOURCE_SHA"\n    COMMIT_STATUS_SHA="$NODE_SOURCE_SHA"'
    );
    expect(sourceRepoBranches?.groups?.remote).toContain(
      'HEAD_SHA="${{ github.sha }}"'
    );
    expect(sourceRepoBranches?.groups?.remote).not.toContain(
      "COMMIT_STATUS_SHA="
    );
    expect(meta).toMatch(
      /else\s+if \[ -z "\$PR_NUMBER" \]; then[\s\S]*?COMMIT_STATUS_SHA="\$HEAD_SHA"/
    );
    expect(pending.if).toBe("steps.meta.outputs.commit_status_sha != ''");
    expect(pending.env?.SHA).toBe(
      "${{ steps.meta.outputs.commit_status_sha }}"
    );
    expect(terminal.if).toBe("needs.decide.outputs.commit_status_sha != ''");
    expect(terminal.env?.SHA).toBe(
      "${{ needs.decide.outputs.commit_status_sha }}"
    );
  });
});
