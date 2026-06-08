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
const candidateFlight = readWorkflow("candidate-flight.yml");
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
    "run: bash ../scripts/ci/detect-remote-source-artifact-targets.sh"
  ) &&
  candidateFlightText.includes(
    'SOURCE_SHA="$NODE_SOURCE_SHA" bash ../scripts/ci/resolve-node-ref-image.sh'
  ) &&
  candidateFlightText.includes(
    "bash ../scripts/ci/resolve-pr-build-images.sh"
  ) &&
  candidateFlightText.includes("COGNI_CATALOG_ROOT: infra/catalog")
) {
  pass(
    "candidate-flight resolves new workflow-source helpers against app-src catalogs"
  );
} else {
  fail(
    "candidate-flight helper steps must run workflow-source scripts from app-src with COGNI_CATALOG_ROOT=infra/catalog"
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

if (
  !/run:\s*[^\n]*deploy-infra\.sh/.test(candidateFlightText) &&
  !/bash\s+[^\n]*deploy-infra\.sh/.test(candidateFlightText)
) {
  pass("candidate-flight does not execute deploy-infra.sh");
} else {
  fail("candidate-flight must not execute deploy-infra.sh from the app flight");
}

const candidateJobs = candidateFlight?.jobs ?? {};
const reconcileSubstrate = candidateJobs["reconcile-substrate"];
const assertSubstrate = candidateJobs["assert-substrate"];
const flight = candidateJobs.flight;
const verifyCandidate = candidateJobs["verify-candidate"];
const reportStatus = candidateJobs["report-status"];

function needsList(job) {
  const needs = job?.needs;
  if (Array.isArray(needs)) {
    return needs;
  }
  if (typeof needs === "string") {
    return [needs];
  }
  return [];
}

if (reconcileSubstrate) {
  pass("candidate-flight defines reconcile-substrate");
} else {
  fail(
    "candidate-flight must define reconcile-substrate before substrate assertion"
  );
}

const reconcileNeeds = new Set(needsList(reconcileSubstrate));
if (
  reconcileNeeds.has("decide") &&
  reconcileNeeds.has("reconcile-appset") &&
  reconcileNeeds.has("reconcile-dns")
) {
  pass("reconcile-substrate waits for decide, AppSet, and DNS reconciliation");
} else {
  fail(
    "reconcile-substrate must need decide, reconcile-appset, and reconcile-dns"
  );
}

const assertNeeds = new Set(needsList(assertSubstrate));
if (
  assertNeeds.has("reconcile-substrate") &&
  String(assertSubstrate?.if ?? "").includes(
    "needs.reconcile-substrate.result == 'success'"
  )
) {
  pass("assert-substrate is gated on reconcile-substrate success");
} else {
  fail(
    "assert-substrate must depend on and require reconcile-substrate success"
  );
}

const flightNeeds = new Set(needsList(flight));
if (
  flightNeeds.has("reconcile-substrate") &&
  String(flight?.if ?? "").includes(
    "needs.reconcile-substrate.result == 'success'"
  )
) {
  pass("flight cannot promote when required substrate reconciliation failed");
} else {
  fail(
    "flight must depend on reconcile-substrate and gate promotion on its success"
  );
}

const verifyNeeds = new Set(needsList(verifyCandidate));
if (
  verifyNeeds.has("reconcile-substrate") &&
  String(verifyCandidate?.if ?? "").includes(
    "needs.reconcile-substrate.result == 'success'"
  )
) {
  pass("verify-candidate carries the reconcile-substrate gate");
} else {
  fail("verify-candidate must carry the reconcile-substrate gate");
}

const reportNeeds = new Set(needsList(reportStatus));
if (
  reportNeeds.has("reconcile-substrate") &&
  reportNeeds.has("assert-substrate") &&
  candidateFlightText.includes("RECONCILE_SUBSTRATE_RESULT") &&
  candidateFlightText.includes("ASSERT_SUBSTRATE_RESULT") &&
  candidateFlightText.includes("Candidate flight failed before promotion")
) {
  pass("report-status exposes substrate reconcile/assert failures");
} else {
  fail(
    "report-status must include reconcile/assert jobs and describe substrate failures before promotion"
  );
}

console.log(`workflows: ${workflowFiles.join(", ")}`);

if (failures > 0) {
  console.error(`workflow check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("workflow check passed");
