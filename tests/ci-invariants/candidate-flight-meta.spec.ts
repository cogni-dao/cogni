// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-flight-meta`
 * Purpose: Pins candidate-flight app/infra independence for node-ref flights.
 * Scope: Static structural test that reads `.github/workflows/candidate-flight.yml`; does not invoke GitHub Actions.
 * Invariants: NODE_REF_FLIGHT_IS_APP_ONLY_BY_DEFAULT, INFRA_LEVER_IS_EXPLICIT.
 * Side-effects: IO (workflow read only)
 * Links: .github/workflows/candidate-flight.yml, docs/spec/ci-cd.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/candidate-flight.yml"
);

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface CandidateFlightWorkflow {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { default?: unknown; type?: string }>;
    };
  };
  jobs: {
    decide: {
      steps: WorkflowStep[];
    };
    flight: {
      steps: WorkflowStep[];
    };
    "deploy-infra": {
      if?: string;
    };
  };
}

function loadWorkflow(): CandidateFlightWorkflow {
  return yaml.parse(
    readFileSync(WORKFLOW_PATH, "utf8")
  ) as CandidateFlightWorkflow;
}

function findStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `candidate-flight step "${name}" must exist`).toBeDefined();
  return step as WorkflowStep;
}

function sliceBetween(text: string, startNeedle: string, endNeedle: string) {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle, start);
  expect(start, `expected to find ${startNeedle}`).toBeGreaterThanOrEqual(0);
  expect(end, `expected to find ${endNeedle}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("candidate-flight workflow · node-ref infra coupling", () => {
  it("node-ref flights are app-only and never dispatch deploy-infra", () => {
    const workflow = loadWorkflow();
    expect(
      workflow.on.workflow_dispatch.inputs.provision_infra
    ).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.include_infra).toMatchObject({
      default: false,
      type: "boolean",
    });

    const infraStep = findStep(
      workflow.jobs.decide.steps,
      "Decide infra inclusion"
    );
    expect(infraStep.env).not.toHaveProperty("PROVISION_INFRA");
    expect(infraStep.env).toHaveProperty("INCLUDE_INFRA");
    expect(infraStep.run).toBeDefined();

    const nodeRefBranch = sliceBetween(
      infraStep.run ?? "",
      'if [ -n "$NODE_SLUG" ]; then',
      'echo "ℹ️  include_infra=false'
    );

    expect(nodeRefBranch).toContain('echo "needs_infra=false"');
    expect(nodeRefBranch).not.toContain('echo "needs_infra=true"');
  });

  it("deploy-infra is reserved behind explicit include_infra", () => {
    const workflow = loadWorkflow();
    const infraStep = findStep(
      workflow.jobs.decide.steps,
      "Decide infra inclusion"
    );
    expect(infraStep.run).toBeDefined();

    const explicitInfraBranch = sliceBetween(
      infraStep.run ?? "",
      'if [ "$INCLUDE_INFRA" = "true" ]; then',
      'if [ -n "$NODE_SLUG" ]; then'
    );

    expect(explicitInfraBranch).toContain('echo "needs_infra=true"');
    expect(infraStep.run).not.toContain("ADDED_CATALOG=");
    expect(workflow.jobs["deploy-infra"].if).toBe(
      "needs.decide.outputs.needs_infra == 'true'"
    );
  });

  it("candidate deploy branches sync generated ExternalSecret leaves with overlays", () => {
    const workflow = loadWorkflow();
    const syncStep = findStep(
      workflow.jobs.flight.steps,
      "Sync base + per-node overlay + per-node catalog to deploy branch"
    );
    expect(syncStep.run).toBeDefined();

    expect(syncStep.run).toContain(
      "app-src/infra/k8s/secrets/external-secrets/candidate-a/${NODE}"
    );
    expect(syncStep.run).toContain(
      "deploy-branch/infra/k8s/secrets/external-secrets/candidate-a/${NODE}"
    );
  });
});
