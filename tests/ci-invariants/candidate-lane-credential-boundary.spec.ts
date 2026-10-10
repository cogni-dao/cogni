// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-lane-credential-boundary`
 * Purpose: Pins which environment's VM credentials a candidate lever may hold.
 * Scope: Static assertions over the candidate-flight workflows; does not execute GitHub Actions, SSH, or deploy.
 * Invariants:
 *   LANE_CREDENTIALS_MATCH_LANE: a step that names a literal lane in
 *     DEPLOY_ENVIRONMENT and also reads `secrets.VM_HOST` / `secrets.SSH_DEPLOY_KEY`
 *     must sit in a job whose `environment` is that same literal lane. Those two
 *     secrets are environment-scoped, so the job's `environment` — not the step's
 *     DEPLOY_ENVIRONMENT — decides which VM is actually reached.
 *   CANDIDATE_LEVER_NEVER_REACHES_PRODUCTION: no job in a candidate lever may
 *     declare an `environment` that resolves to production while a step in it
 *     claims to be operating on a candidate lane.
 * Side-effects: IO (reads .github/workflows/candidate-flight*.yml)
 * Links: bug.5394, docs/spec/ci-cd.md, .claude/skills/devops-expert/SKILL.md rule 3
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CANDIDATE_WORKFLOWS = [
  ".github/workflows/candidate-flight.yml",
  ".github/workflows/candidate-flight-infra.yml",
];

/**
 * bug.5394 — #2602 flipped `external-node-preflight` to
 * `environment: ${{ vars.FLEET_CONTROL_ENV || 'production' }}` while its steps kept
 * passing `DEPLOY_ENVIRONMENT: candidate-a`. `FLEET_CONTROL_ENV` is unset, so every
 * Akash node's candidate flight SSHed root@production, reconciled three lanes there,
 * and then asked the production cluster about candidate-a's namespace. Eight
 * consecutive poly/red preflights failed on a message that blamed a healthy actuator.
 *
 * The step's DEPLOY_ENVIRONMENT says which lane we MEAN; the job's `environment` says
 * which VM we actually REACH. When they disagree, every answer is about the wrong
 * machine. This file is the static check that disagreement cannot merge again — #2602
 * was reviewed, unit-tested and merged, so review alone demonstrably does not catch it.
 */

interface WorkflowStep {
  name?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  environment?: unknown;
  steps?: WorkflowStep[];
}

const VM_CREDENTIAL_SECRETS = ["secrets.VM_HOST", "secrets.SSH_DEPLOY_KEY"];

function jobEnvironmentName(environment: unknown): string | undefined {
  if (typeof environment === "string") return environment;
  if (environment && typeof environment === "object") {
    const name = (environment as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function isExpression(value: string): boolean {
  return value.includes("${{");
}

function readsVmCredentials(step: WorkflowStep): boolean {
  const blob = JSON.stringify({ env: step.env ?? {}, with: step.with ?? {} });
  return VM_CREDENTIAL_SECRETS.some((secret) => blob.includes(secret));
}

function declaredLane(step: WorkflowStep): string | undefined {
  const raw =
    (step.env?.DEPLOY_ENVIRONMENT as unknown) ??
    (step.with?.deploy_environment as unknown);
  if (typeof raw !== "string") return undefined;
  if (isExpression(raw)) return undefined;
  return raw;
}

describe.each(CANDIDATE_WORKFLOWS)("%s", (workflowPath) => {
  const parsed = yaml.parse(
    readFileSync(path.join(REPO_ROOT, workflowPath), "utf8")
  ) as { jobs?: Record<string, WorkflowJob> };
  const jobs = Object.entries(parsed.jobs ?? {});

  it("has jobs to check", () => {
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("LANE_CREDENTIALS_MATCH_LANE: a step holding VM credentials for a named lane runs in that lane's environment", () => {
    const violations: string[] = [];

    for (const [jobId, job] of jobs) {
      const environment = jobEnvironmentName(job.environment);
      for (const step of job.steps ?? []) {
        const lane = declaredLane(step);
        if (lane === undefined || !readsVmCredentials(step)) continue;

        const where = `${jobId} / step "${step.name ?? "(unnamed)"}"`;
        if (environment === undefined) {
          violations.push(
            `${where} reads VM credentials for lane '${lane}' but its job declares no \`environment\`, so VM_HOST/SSH_DEPLOY_KEY resolve to the repository default rather than '${lane}'`
          );
          continue;
        }
        if (isExpression(environment)) {
          violations.push(
            `${where} reads VM credentials for lane '${lane}' while its job's environment is the expression \`${environment}\` — the lane reached is then whatever that expression evaluates to, which is exactly the #2602 shape. Pin the job to '${lane}', or move the lane-scoped assertion into its own \`environment: ${lane}\` job.`
          );
          continue;
        }
        if (environment !== lane) {
          violations.push(
            `${where} reads VM credentials for lane '${lane}' but its job's environment is '${environment}', so it reaches '${environment}'s VM while every assertion claims to be about '${lane}'`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("CANDIDATE_LEVER_NEVER_REACHES_PRODUCTION: no lane-scoped step in a candidate lever resolves its credentials to production", () => {
    const violations: string[] = [];

    for (const [jobId, job] of jobs) {
      const environment = jobEnvironmentName(job.environment);
      if (environment === undefined) continue;
      const mentionsProduction = environment.includes("production");
      if (!mentionsProduction) continue;

      for (const step of job.steps ?? []) {
        if (!readsVmCredentials(step)) continue;
        const lane = declaredLane(step);
        if (lane === undefined || lane === "production") continue;
        violations.push(
          `${jobId} / step "${step.name ?? "(unnamed)"}" operates on lane '${lane}' but its job's environment \`${environment}\` can resolve to production, giving a candidate lever root on the production VM`
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
