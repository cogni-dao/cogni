// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-infra-source`
 * Purpose: Pin immutable source provenance for operator-dispatched candidate infra flights.
 * Scope: Static assertions over candidate-flight-infra.yml; does not dispatch or deploy.
 * Invariants:
 *   - EXACT_REVIEWED_SOURCE: the operator-validated immutable source SHA pins both workflow scripts
 *     and deploy-infra input; blank manual dispatches fall back to the workflow event SHA/ref.
 * Side-effects: IO (reads .github/workflows/candidate-flight-infra.yml)
 * Links: task.5100, docs/spec/ci-cd.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/candidate-flight-infra.yml"),
  "utf8"
);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

const parsed = yaml.parse(WORKFLOW) as {
  readonly jobs: {
    readonly "flight-infra": { readonly steps: readonly WorkflowStep[] };
  };
};

function namedStep(name: string): WorkflowStep {
  const step = parsed.jobs["flight-infra"].steps.find(
    (candidate) => candidate.name === name
  );
  expect(step, `${name} step must exist`).toBeDefined();
  return step as WorkflowStep;
}

describe("candidate infra source", () => {
  it("pins workflow scripts to the selected SHA or immutable event SHA", () => {
    expect(namedStep("Checkout (for scripts)").with?.ref).toBe(
      "${{ inputs.ref || github.sha }}"
    );
  });

  it("passes the operator-selected immutable ref to deploy-infra", () => {
    expect(namedStep("Deploy Compose infra to candidate-a VM").run).toContain(
      'bash scripts/ci/deploy-infra.sh --ref "$COGNI_REPO_REF"'
    );
    expect(WORKFLOW).toContain(
      "COGNI_REPO_REF: ${{ inputs.ref || github.ref_name }}"
    );
  });
});
