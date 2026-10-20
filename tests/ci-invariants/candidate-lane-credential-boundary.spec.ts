// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-lane-credential-boundary`
 * Purpose: Pins which environment's VM credentials a candidate lever may hold.
 * Scope: Static assertions over the candidate-flight workflows; does not execute GitHub Actions, SSH, or deploy.
 * Invariants:
 *   LANE_CREDENTIALS_MATCH_LANE: a step that names a literal lane in
 *     DEPLOY_ENVIRONMENT and also reads `secrets.VM_HOST` / `secrets.SSH_DEPLOY_KEY`
 *     must sit in a job whose `environment` is that same literal lane, except the
 *     exact reviewed task.5255 secret-custodian bridge. Those two
 *     secrets are environment-scoped, so the job's `environment` — not the step's
 *     DEPLOY_ENVIRONMENT — decides which VM is actually reached.
 *   CANDIDATE_LEVER_NEVER_REACHES_PRODUCTION: no application job in a candidate lever may
 *     declare an `environment` that resolves to production while a step in it
 *     claims to be operating on a candidate lane, outside that bounded bridge.
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
  if?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  environment?: unknown;
  env?: Record<string, unknown>;
  strategy?: { matrix?: { node?: unknown } };
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

// task.5255: the approved secret custodian executes only the existing bounded
// wrapper. Compute/secret custody is not PG residency: the wrapper delegates PG
// to the lane owner and enforces DSN agreement. No other candidate step inherits
// this exception, including any direct reconcile added to this same job.
function isCustodianBridgeStep(
  workflowPath: string,
  jobId: string,
  job: WorkflowJob,
  step: WorkflowStep
): boolean {
  if (
    workflowPath !== ".github/workflows/candidate-flight.yml" ||
    jobId !== "external-node-preflight" ||
    jobEnvironmentName(job.environment) !==
      "${{ vars.FLEET_CONTROL_ENV || 'production' }}" ||
    job.env?.DEPLOYMENT_PROVIDER !==
      "${{ fromJSON(needs.decide.outputs.deployment_provider_by_target_json)[matrix.node] }}" ||
    job.strategy?.matrix?.node !==
      "${{ fromJson(needs.decide.outputs.external_compute_node_targets_json) }}" ||
    declaredLane(step) !== "candidate-a"
  ) {
    return false;
  }
  const secretReferences = Array.from(
    JSON.stringify(step).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g),
    (match) => match[1]
  )
    .sort()
    .join(",");
  // task.5281: one additional recipient may only inventory the owning template lane.
  // It cannot materialize, close, audit or activate; its entrypoint fails closed afterward.
  if (
    step.name === "Read owning candidate producer inventory before mutation"
  ) {
    return (
      step.if ===
        "matrix.node == 'node-template' && github.repository == 'cogni-dao/cogni'" &&
      secretReferences === "GIT_READ_TOKEN,VM_HOST" &&
      Object.keys(step.env ?? {})
        .sort()
        .join(",") ===
        "APP_SOURCE_ROOT,CI_SOURCE_ROOT,CONTROL_ENV,DEPLOY_ENVIRONMENT,GH_TOKEN,NODE,VM_HOST" &&
      step.env?.VM_HOST === "${{ secrets.VM_HOST }}" &&
      step.env?.GH_TOKEN === "${{ secrets.GIT_READ_TOKEN }}" &&
      step.env?.CONTROL_ENV ===
        "${{ vars.FLEET_CONTROL_ENV || 'production' }}" &&
      step.env?.NODE === "${{ matrix.node }}" &&
      step.env?.CI_SOURCE_ROOT === "${{ github.workspace }}/ci-src" &&
      step.env?.APP_SOURCE_ROOT === "${{ github.workspace }}/app-src" &&
      step.run?.trim() ===
        "pnpm --dir ci-src exec tsx --tsconfig nodes/operator/app/tsconfig.app.json scripts/ops/maintenance-drain.mjs candidate-preflight"
    );
  }
  if (step.name === "Setup SSH to candidate-a VM") {
    return (
      secretReferences === "SSH_DEPLOY_KEY,VM_HOST" &&
      Object.keys(step.env ?? {})
        .sort()
        .join(",") ===
        "DEPLOY_ENVIRONMENT,NODE_SOURCE_SHA,SSH_DEPLOY_KEY,VM_HOST" &&
      step.env?.VM_HOST === "${{ secrets.VM_HOST }}" &&
      step.env?.SSH_DEPLOY_KEY === "${{ secrets.SSH_DEPLOY_KEY }}" &&
      step.run?.trim() ===
        `set -euo pipefail
bash ci-src/scripts/ci/require-node-ref-vm.sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "$SSH_DEPLOY_KEY" | tr -d '\\r' > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
ssh-keyscan -T 10 -H "$VM_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true`
    );
  }
  return (
    step.name === "Provision node state and assert Akash prerequisites" &&
    secretReferences === "VM_HOST" &&
    Object.keys(step.env ?? {})
      .sort()
      .join(",") ===
      "APP_SOURCE_DIR,COGNI_CATALOG_ROOT,DEPLOY_ENVIRONMENT,DOMAIN,HEAD_SHA,NODE_SOURCE_SHA,SSH_OPTS,STATUS_URL,VM_HOST" &&
    step.env?.VM_HOST === "${{ secrets.VM_HOST }}" &&
    step.env?.APP_SOURCE_DIR === "app-src" &&
    step.env?.COGNI_CATALOG_ROOT === "infra/catalog" &&
    step.run?.trim() ===
      'bash ci-src/scripts/ci/run-node-substrate.sh candidate-a "${{ matrix.node }}"'
  );
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
        if (isCustodianBridgeStep(workflowPath, jobId, job, step)) continue;

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
        if (isCustodianBridgeStep(workflowPath, jobId, job, step)) continue;
        violations.push(
          `${jobId} / step "${step.name ?? "(unnamed)"}" operates on lane '${lane}' but its job's environment \`${environment}\` can resolve to production, giving a candidate lever root on the production VM`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("CUSTODIAN_BRIDGE_IS_EXACT: only the reviewed wrapper, SSH setup and read-only inventory receive custody authority", () => {
    if (workflowPath !== ".github/workflows/candidate-flight.yml") return;
    const jobId = "external-node-preflight";
    const job = parsed.jobs?.[jobId];
    expect(job).toBeDefined();
    if (!job) throw new Error("external-node-preflight job is required");
    const credentialSteps = job?.steps?.filter(readsVmCredentials) ?? [];
    expect(credentialSteps).toHaveLength(3);
    for (const step of credentialSteps) {
      expect(isCustodianBridgeStep(workflowPath, jobId, job, step)).toBe(true);
      expect(
        isCustodianBridgeStep(workflowPath, "application", job, step)
      ).toBe(false);
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, {
          ...step,
          env: {
            ...step.env,
            NODE_SOURCE_SHA: "${{ secrets.PRODUCTION_KEY }}",
          },
        })
      ).toBe(false);
      expect(
        isCustodianBridgeStep(
          workflowPath,
          jobId,
          { ...job, environment: "production" },
          step
        )
      ).toBe(false);
      expect(
        isCustodianBridgeStep(workflowPath, jobId, { ...job, env: {} }, step)
      ).toBe(false);
      expect(
        isCustodianBridgeStep(
          workflowPath,
          jobId,
          { ...job, strategy: {} },
          step
        )
      ).toBe(false);
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, {
          ...step,
          run: "bash ci-src/scripts/ci/reconcile-node-substrate.sh candidate-a poly",
        })
      ).toBe(false);
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, {
          ...step,
          env: {
            ...step.env,
            EXTRA_AUTHORITY: "${{ secrets.PRODUCTION_KEY }}",
          },
        })
      ).toBe(false);
    }
  });
  it("READ_ONLY_INVENTORY_IS_EXACT: refuses arbitrary commands, targets and authority", () => {
    if (workflowPath !== ".github/workflows/candidate-flight.yml") return;
    const jobId = "external-node-preflight";
    const job = parsed.jobs?.[jobId];
    if (!job) throw new Error("external-node-preflight job is required");
    const steps = (job.steps ?? []).filter(
      (step) =>
        step.name === "Read owning candidate producer inventory before mutation"
    );
    expect(steps).toHaveLength(1);
    const step = steps[0];
    if (!step || typeof step.run !== "string")
      throw new Error("read-only inventory step is required");
    expect(isCustodianBridgeStep(workflowPath, jobId, job, step)).toBe(true);
    for (const run of [
      "ssh root@host true",
      "psql -c 'SELECT 1'",
      step.run.replace("candidate-preflight", "close"),
      `${step.run} --sql 'SELECT 1'`,
    ]) {
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, { ...step, run })
      ).toBe(false);
    }
    for (const env of [
      { ...step.env, NODE: "poly" },
      { ...step.env, CONTROL_ENV: "preview" },
      { ...step.env, DEPLOY_ENVIRONMENT: "production" },
      { ...step.env, GH_TOKEN: "${{ secrets.PRODUCTION_KEY }}" },
      { ...step.env, EXTRA_AUTHORITY: "${{ secrets.PRODUCTION_KEY }}" },
      { ...step.env, SQL: "SELECT 1" },
    ])
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, { ...step, env })
      ).toBe(false);
    for (const condition of [
      "matrix.node == 'poly'",
      "github.repository == 'other/repo'",
      "",
    ]) {
      expect(
        isCustodianBridgeStep(workflowPath, jobId, job, {
          ...step,
          if: condition,
        })
      ).toBe(false);
    }
    expect(isCustodianBridgeStep(workflowPath, "application", job, step)).toBe(
      false
    );
    expect(
      isCustodianBridgeStep(
        workflowPath,
        jobId,
        { ...job, environment: "production" },
        step
      )
    ).toBe(false);
  });
});
