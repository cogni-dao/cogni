#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/workflow-check`
 * Purpose: Validate the local GitHub Actions workflow surface that agents rely on.
 * Scope: Reads `.github/workflows/*.y{a,}ml`; does not call GitHub or dispatch workflows.
 * Invariants: DISPATCHABLE_WORKFLOWS_DECLARED — manual levers must expose `workflow_dispatch`.
 * Side-effects: IO (filesystem reads)
 * Links: .github/workflows/ACTION_TRIGGERS.md
 * @internal
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW_DIR = ".github/workflows";

const requiredFiles = ["ci.yaml", "pr-lint.yaml"];
const removedFiles = ["ci.yml", "lint-pr.yml"];
const manualWorkflows = [
  "candidate-flight.yml",
  "candidate-flight-infra.yml",
  "flight-preview.yml",
  "promote-and-deploy.yml",
  "release.yml",
  "stack-test.yml",
];
const nonDispatchWorkflows = ["ci.yaml", "pr-lint.yaml", "pr-build.yml"];

let failures = 0;

function pass(message) {
  console.log(`ok: ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`fail: ${message}`);
}

function readWorkflow(file) {
  const path = join(WORKFLOW_DIR, file);
  if (!existsSync(path)) {
    return null;
  }
  return parseYaml(readFileSync(path, "utf8"));
}

function readWorkflowText(file) {
  const path = join(WORKFLOW_DIR, file);
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function triggersFor(file) {
  const workflow = readWorkflow(file);
  const on = workflow?.on;
  if (!on) {
    return new Set();
  }
  if (typeof on === "string") {
    return new Set([on]);
  }
  if (Array.isArray(on)) {
    return new Set(on.map(String));
  }
  if (typeof on === "object") {
    return new Set(Object.keys(on));
  }
  return new Set();
}

for (const file of requiredFiles) {
  if (existsSync(join(WORKFLOW_DIR, file))) {
    pass(`${file} exists`);
  } else {
    fail(`${file} is missing`);
  }
}

for (const file of removedFiles) {
  if (existsSync(join(WORKFLOW_DIR, file))) {
    fail(`${file} exists; use the .yaml workflow filename`);
  } else {
    pass(`${file} absent`);
  }
}

for (const file of manualWorkflows) {
  const triggers = triggersFor(file);
  if (triggers.has("workflow_dispatch")) {
    pass(`${file} is manually dispatchable`);
  } else {
    fail(`${file} lacks workflow_dispatch`);
  }
}

for (const file of nonDispatchWorkflows) {
  const triggers = triggersFor(file);
  if (triggers.has("workflow_dispatch")) {
    fail(`${file} unexpectedly has workflow_dispatch`);
  } else {
    pass(`${file} is event-driven only`);
  }
}

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();

const candidateFlightText = readWorkflowText("candidate-flight.yml");
if (
  candidateFlightText.includes(
    "REMOTE_SOURCE_ARTIFACT_TARGETS_FILE: ${{ steps.remote-source-artifact-targets.outputs.targets_file }}"
  )
) {
  pass(
    "candidate-flight wires remote-source artifact target manifest output into image resolution"
  );
} else {
  fail(
    "candidate-flight must pass steps.remote-source-artifact-targets.outputs.targets_file to REMOTE_SOURCE_ARTIFACT_TARGETS_FILE"
  );
}

if (
  candidateFlightText.includes(
    "username: ${{ secrets.GHCR_DEPLOY_USERNAME || github.actor }}"
  ) &&
  candidateFlightText.includes(
    "password: ${{ secrets.GHCR_DEPLOY_TOKEN || github.token }}"
  )
) {
  pass("candidate-flight prefers deploy-token GHCR credentials");
} else {
  fail(
    "candidate-flight GHCR login must prefer GHCR_DEPLOY_* secrets with GitHub token fallback"
  );
}

console.log(`workflows: ${workflowFiles.join(", ")}`);

if (failures > 0) {
  console.error(`workflow check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("workflow check passed");
