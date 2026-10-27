// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/candidate-manifest-source`
 * Purpose: Pins pre-merge manifest provenance for candidate-a node-ref flights.
 * Scope: Workflow assertions and owned local Kustomize/Git fixtures; does not execute remote Actions or deploy.
 * Invariants:
 *   CANDIDATE_MANIFESTS_FOLLOW_IN_REPO_SOURCE: an in-repo node-ref flight uses
 *     source_sha as head_sha, so infra/k8s is materialized from the exact
 *     flighted revision rather than the workflow's main revision.
 *   REMOTE_NODE_SOURCE_STAYS_SEPARATE: a remote node's source SHA is not used
 *     as a parent-monorepo checkout ref.
 *   CONTROL_DOMAIN_STAYS_SEPARATE: a test parent's Akash workload zone never
 *     replaces its explicitly configured k3s operator/control domain during
 *     substrate or public checks.
 *   DEPLOY_REPO_OWNS_APPSET: AppSet reconciliation renders repoURL for the
 *     repository that owns the deploy branch instead of the canonical default;
 *     writer, AppSet, verification checkout, and ancestry check share one resolver.
 *   EXACT_SELF_FLIGHT_PROVES_SUBSTRATE_SCRIPTS: the operator may execute the
 *     reviewed app-source substrate runner only when workflow and app are the
 *     same commit; all remote or mismatched source flights stay on ci-src.
 * Side-effects: IO (reads workflow inputs; creates and removes owned temporary render/Git fixtures)
 * Links: docs/spec/ci-cd.md axioms 17-20, docs/spec/node-ci-cd-contract.md artifact contract
 * @public
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/candidate-flight.yml"),
  "utf8"
);
const CANDIDATE_OPERATOR_OVERLAY = readFileSync(
  path.join(
    REPO_ROOT,
    "infra/k8s/overlays/candidate-a/operator/kustomization.yaml"
  ),
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
  if?: string;
  needs?: string[];
  outputs?: Record<string, unknown>;
  concurrency?: { group?: unknown; "cancel-in-progress"?: boolean };
  steps: WorkflowStep[];
}

const parsed = yaml.parse(WORKFLOW) as {
  concurrency?: { group?: unknown; "cancel-in-progress"?: boolean };
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
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
  it("pairs preparatory init entrypoints with the preserved image, then restores the new audited rollout", () => {
    const fixture = mkdtempSync(
      path.join(os.tmpdir(), "candidate-init-contract-")
    );
    const deploy = path.join(fixture, "deploy");
    const source = path.join(fixture, "source");
    const relative = "infra/k8s/overlays/candidate-a/operator";
    const snapshot = path.join(fixture, "old-init.json");
    const oldDigest = `sha256:${"1".repeat(64)}`;
    const newDigest = `sha256:${"2".repeat(64)}`;
    const image = "ghcr.io/cogni-dao/cogni-template";
    const oldImage = `${image}@${oldDigest}`;
    const helper = path.join(REPO_ROOT, "scripts/ci/lib/overlay-digest.sh");
    const prepare =
      namedStep(
        "prepare-substrate-deploy-branch",
        "Prepare deploy branch shape"
      ).run ?? "";
    const finalSync =
      namedStep(
        "flight",
        "Sync base + per-node overlay + per-node catalog to deploy branch"
      ).run ?? "";
    const run = (command: string, args: string[], cwd = deploy) =>
      execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
    const contract = (operation: "snapshot" | "restore") =>
      run("bash", [
        "-euo",
        "pipefail",
        "-c",
        'source "$1"; "${2}_overlay_init_contract" candidate-a operator "$3" "$4"',
        "fixture",
        helper,
        operation,
        oldImage,
        snapshot,
      ]);
    const render = () => {
      const docs = yaml.parseAllDocuments(
        run("kubectl", ["kustomize", path.join(deploy, relative)])
      );
      const deployments = docs
        .map((doc) => doc.toJSON())
        .filter((doc) => doc?.kind === "Deployment");
      expect(deployments).toHaveLength(1);
      return deployments[0];
    };
    const writeOverlay = (root: string, digest: string, modern: boolean) => {
      const overlay = path.join(root, relative);
      mkdirSync(overlay, { recursive: true });
      writeFileSync(
        path.join(overlay, "kustomization.yaml"),
        yaml.stringify({
          apiVersion: "kustomize.config.k8s.io/v1beta1",
          kind: "Kustomization",
          namePrefix: "operator-",
          resources: ["deployment.yaml"],
          images: [{ name: image, newName: image, digest }],
        })
      );
      writeFileSync(
        path.join(overlay, "deployment.yaml"),
        yaml.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "node-app" },
          spec: {
            strategy: { type: modern ? "Recreate" : "RollingUpdate" },
            selector: { matchLabels: { app: "fixture" } },
            template: {
              metadata: { labels: { app: "fixture" } },
              spec: {
                containers: [{ name: "app", image }],
                initContainers: modern
                  ? [
                      {
                        name: "migrate",
                        image,
                        command: ["new-pg"],
                        args: ["new-pg-arg"],
                      },
                      {
                        name: "migrate-doltgres",
                        image,
                        command: ["migrateOperatorAfterNativeDrain"],
                        args: ["new-dolt-arg"],
                      },
                    ]
                  : [
                      { name: "migrate", image, command: ["old-pg"] },
                      {
                        name: "migrate-doltgres",
                        image,
                        args: ["old-dolt-arg"],
                      },
                    ],
              },
            },
          },
        })
      );
    };
    const syncSource = () =>
      run("rsync", [
        "-a",
        "--delete",
        `${path.join(source, relative)}/`,
        `${path.join(deploy, relative)}/`,
      ]);
    const promote = (digest: string) =>
      run("bash", [
        path.join(REPO_ROOT, "scripts/ci/promote-k8s-image.sh"),
        "--no-commit",
        "--env",
        "candidate-a",
        "--app",
        "operator",
        "--digest",
        `${image}@${digest}`,
      ]);
    try {
      writeOverlay(deploy, oldDigest, false);
      writeOverlay(source, newDigest, true);
      run("git", ["init", "--quiet"]);
      run("git", [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "old deploy HEAD",
      ]);
      const old = render();
      contract("snapshot");
      syncSource();
      promote(oldDigest);
      // Historical preparation reproduces the mismatched old image/new export.
      expect(render().spec.template.spec.initContainers[1].command).toEqual([
        "migrateOperatorAfterNativeDrain",
      ]);
      contract("restore");
      const prepared = render();
      expect(prepared.spec.strategy.type).toBe("Recreate");
      expect(prepared.spec.template.spec.initContainers).toEqual(
        old.spec.template.spec.initContainers
      );
      expect(prepared.spec.template.spec.containers[0].image).toBe(oldImage);
      expect(prepared.spec.template.spec.initContainers[0]).not.toHaveProperty(
        "args"
      );
      expect(prepared.spec.template.spec.initContainers[1]).not.toHaveProperty(
        "command"
      );
      syncSource();
      expect(
        existsSync(
          path.join(deploy, relative, ".prepare-init-compatibility.json")
        )
      ).toBe(false);
      promote(newDigest);
      const final = render();
      expect(final.spec.template.spec.initContainers[1].command).toEqual([
        "migrateOperatorAfterNativeDrain",
      ]);
      expect(
        final.spec.template.spec.initContainers.every(
          (container: { image: string }) =>
            container.image === `${image}@${newDigest}`
        )
      ).toBe(true);
      expect(final.spec.template.spec.containers[0].image).toBe(
        `${image}@${newDigest}`
      );
      expect(
        readFileSync(path.join(deploy, relative, "kustomization.yaml"), "utf8")
      ).not.toContain(".prepare-init-compatibility");
      // Unknown/new init names and changed deploy ownership must fail closed.
      promote(oldDigest);
      const deploymentPath = path.join(deploy, relative, "deployment.yaml");
      const deployment = yaml.parse(readFileSync(deploymentPath, "utf8"));
      deployment.spec.template.spec.initContainers.push({
        name: "unmatched",
        image,
      });
      writeFileSync(deploymentPath, yaml.stringify(deployment));
      expect(() => contract("restore")).toThrow();
      syncSource();
      promote(oldDigest);
      run("git", [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "changed deploy HEAD",
      ]);
      expect(() => contract("restore")).toThrow();
      // Init-free named services remain an unchanged no-op, not a missing-node failure.
      syncSource();
      promote(oldDigest);
      const service = yaml.parse(readFileSync(deploymentPath, "utf8"));
      service.metadata.name = "operator";
      service.spec.template.spec.initContainers = [];
      writeFileSync(deploymentPath, yaml.stringify(service));
      const kustomizationPath = path.join(
        deploy,
        relative,
        "kustomization.yaml"
      );
      const kustomization = yaml.parse(readFileSync(kustomizationPath, "utf8"));
      delete kustomization.namePrefix;
      writeFileSync(kustomizationPath, yaml.stringify(kustomization));
      contract("snapshot");
      const serviceBefore = render();
      contract("restore");
      expect(render()).toEqual(serviceBefore);
      expect(
        existsSync(
          path.join(deploy, relative, ".prepare-init-compatibility.json")
        )
      ).toBe(false);
      expect(prepare.indexOf("snapshot_overlay_init_contract")).toBeLessThan(
        prepare.indexOf("rsync -a --delete ../app-src/infra/k8s/base/")
      );
      expect(prepare.indexOf("restore_overlay_init_contract")).toBeGreaterThan(
        prepare.indexOf("bash ../ci-src/scripts/ci/promote-k8s-image.sh")
      );
      expect(finalSync).toContain("rsync -a --delete");
      expect(finalSync).not.toContain("restore_overlay_init_contract");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("queues duplicate same-node flights without cancellation", () => {
    expect(parsed.concurrency?.group).toBe(
      "candidate-flight-${{ inputs.pr_number || inputs.node_slug }}"
    );
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("keeps the k3s control domain separate from an isolated Akash workload zone", () => {
    const targetDomain =
      "${{ fromJSON(needs.decide.outputs.deployment_provider_by_target_json)[matrix.node] == 'k3s' && (vars.CANDIDATE_OPERATOR_DOMAIN || format('test.{0}', vars.FORK_DOMAIN_ROOT || 'cognidao.org')) || vars.DOMAIN }}";

    expect(
      namedStep(
        "node-substrate",
        "Run node substrate (materialize -> reconcile)"
      ).env?.DOMAIN
    ).toBe(targetDomain);
    expect(
      namedStep("assert-substrate", "Assert target substrate").env?.DOMAIN
    ).toBe(targetDomain);
    expect(
      namedStep("verify-candidate", "Wait for candidate readiness").env?.DOMAIN
    ).toBe(targetDomain);
    expect(
      namedStep("verify-candidate", "Verify buildSha on endpoint (per-node)")
        .env?.DOMAIN
    ).toBe(targetDomain);
    expect(
      namedStep("verify-candidate", "Run candidate smoke checks (per-node)").env
        ?.DOMAIN
    ).toBe(targetDomain);
    expect(
      namedStep("assert-substrate", "Assert target substrate").env?.CHECK_DNS
    ).toBe(
      "${{ secrets.CLOUDFLARE_API_TOKEN != '' && secrets.CLOUDFLARE_ZONE_ID != '' && 'true' || 'false' }}"
    );
    expect(CANDIDATE_OPERATOR_OVERLAY).toContain(
      "path: /data/FORK_DOMAIN_ROOT"
    );
    expect(CANDIDATE_OPERATOR_OVERLAY).toContain('value: "cogni-testing.org"');
  });

  it("renders the live AppSet for the repository that owns the deploy branch", () => {
    const apply = namedStep(
      "reconcile-appset",
      "Apply candidate-a-${{ matrix.node }}-applicationset.yaml"
    ).run;

    expect(apply).toBeTypeOf("string");
    expect(apply).toContain('REPO_URL="${{ steps.deploy-repo.outputs.url }}"');
    expect(apply).toContain(
      'bash ci-src/scripts/ci/render-node-appset.sh candidate-a "$NODE" >"$RENDERED_APPSET"'
    );
    expect(apply).toContain(
      'ci_ssh_retry scp "${ssh_opts[@]}" "$RENDERED_APPSET"'
    );
  });

  it("binds deploy writers and verifiers to the same resolved repository", () => {
    const resolver =
      "bash ci-src/scripts/ci/resolve-candidate-deploy-repository.sh";
    const prepareResolve = namedStep(
      "prepare-substrate-deploy-branch",
      "Resolve watched deploy repository"
    );
    const appsetResolve = namedStep(
      "reconcile-appset",
      "Resolve watched deploy repository"
    );
    const flightResolve = namedStep(
      "flight",
      "Resolve watched deploy repository"
    );
    const verifyResolve = namedStep(
      "verify-candidate",
      "Resolve watched deploy repository"
    );

    for (const step of [
      prepareResolve,
      appsetResolve,
      flightResolve,
      verifyResolve,
    ]) {
      expect(step.run).toBe(resolver);
      expect(step.env?.SYNC_MANIFEST_PATH).toBe(
        "ci-src/.cogni/sync-manifest.yaml"
      );
    }

    const prepare = namedStep(
      "prepare-substrate-deploy-branch",
      "Prepare deploy branch shape"
    );
    const flight = namedStep(
      "flight",
      "Prepare per-node deploy branch workspace"
    );
    for (const writer of [prepare, flight]) {
      expect(writer.env?.DEPLOY_REPOSITORY).toBe(
        "${{ steps.deploy-repo.outputs.repository }}"
      );
      expect(writer.run).toContain(
        'github.com/${DEPLOY_REPOSITORY}.git" deploy-branch'
      );
    }

    const checkout = namedStep(
      "verify-candidate",
      "Checkout per-node deploy branch (for source-sha map)"
    );
    const wait = namedStep(
      "verify-candidate",
      "Wait for ArgoCD sync (per-node)"
    );
    expect(checkout.with?.repository).toBe(
      "${{ steps.deploy-repo.outputs.repository }}"
    );
    expect(wait.env?.GH_REPO).toBe(
      "${{ steps.deploy-repo.outputs.repository }}"
    );
  });

  it("selects the flighted source SHA for an in-repo node-ref", () => {
    const meta = namedStep("decide", "Resolve PR metadata").run;

    expect(meta).toBeTypeOf("string");
    expect(meta).toContain('CATALOG="infra/catalog/${NODE_SLUG}.yaml"');
    expect(meta).toMatch(
      /SOURCE_REPO=\$\(yq -N '\.source_repo \/\/ ""' "\$CATALOG"\)\s+if \[ -z "\$SOURCE_REPO" \]; then[\s\S]*?HEAD_SHA="\$NODE_SOURCE_SHA"/
    );
  });

  it("preserves the full PR target set for a same-repo node-ref", () => {
    const meta = namedStep("decide", "Resolve PR metadata").run;
    const files = namedStep("decide", "Fetch PR changed-paths from GitHub API");
    const combine = namedStep("decide", "Combine flight targets");
    const images = namedStep("decide", "Resolve PR image digests");

    expect(meta).toContain(
      '"repos/${{ github.repository }}/commits/${NODE_SOURCE_SHA}/pulls"'
    );
    expect(meta).toContain('RESOLVED_PR_NUMBER="${MATCHING_PRS[0]}"');
    expect(files.env?.RESOLVED_PR_NUMBER).toBe(
      "${{ steps.meta.outputs.resolved_pr_number }}"
    );
    expect(files.run).toContain(
      'if [ -n "$NODE_SLUG" ] && [ -z "$RESOLVED_PR_NUMBER" ]; then'
    );
    expect(combine.run).toContain(
      'if [ -n "$NODE_SLUG" ] && [ -z "$RESOLVED_PR_NUMBER" ]; then'
    );
    expect(combine.env?.NORMAL_FLIGHT_TARGETS_JSON).toBe(
      "${{ steps.detect.outputs.flight_targets_json }}"
    );
    expect(images.run).toContain(
      'if [ -n "$NODE" ] && [ -z "$RESOLVED_PR_NUMBER" ]; then'
    );
    expect(images.run).toContain("resolve-pr-build-images.sh");
  });

  it("fails an affected node-ref before mutation when its exact image is absent", () => {
    const guard = namedStep("decide", "Require requested node image");

    // Behavioral scope cases execute the workflow in deployment-workflows.test.sh.
    // This structural invariant pins the guard to the authoritative affected set.
    expect(guard.if).toContain(
      "steps.flight-targets.outputs.flight_targets_json"
    );
    expect(guard.env?.NODE).toBe("${{ steps.meta.outputs.node_slug }}");
    expect(guard.env?.PAYLOAD_FILE).toBe(
      "${{ runner.temp }}/resolved-pr-images.json"
    );
    expect(guard.run).toContain("if sys.argv[2] not in targets:");
    expect(guard.run).toContain("Requested node image is not available yet");
  });

  it("writes scheduler routing to the deploy repository Argo actually watches", () => {
    const resolve = namedStep(
      "reconcile-scheduler-worker-routing",
      "Resolve watched deploy repository"
    );
    const reconcile = namedStep(
      "reconcile-scheduler-worker-routing",
      "Reconcile scheduler-worker routing (propagate to per-env deploy branch)"
    );
    const workspace = namedStep(
      "reconcile-scheduler-worker-routing",
      "Prepare scheduler-worker deploy branch workspace"
    );
    const promote = namedStep(
      "reconcile-scheduler-worker-routing",
      "Promote scheduler-worker in the same branch transaction"
    );
    const push = namedStep(
      "reconcile-scheduler-worker-routing",
      "Commit and push atomic scheduler-worker desired state"
    );
    const genericPrepare = namedStep(
      "flight",
      "Prepare per-node deploy branch workspace"
    );
    const genericSync = namedStep(
      "flight",
      "Sync base + per-node overlay + per-node catalog to deploy branch"
    );
    const genericPush = namedStep(
      "flight",
      "Commit and push to per-node deploy branch"
    );

    expect(resolve.env?.DEPLOYMENT_PROVIDER).toBe("k3s");
    expect(resolve.run).toBe(
      "bash scripts/ci/resolve-candidate-deploy-repository.sh"
    );
    expect(workspace.env?.DEPLOY_REPOSITORY).toBe(
      "${{ steps.deploy-repo.outputs.repository }}"
    );
    expect(workspace.run).toContain(
      'git clone "https://x-access-token:${GH_TOKEN}@github.com/${DEPLOY_REPOSITORY}.git" deploy-branch'
    );
    expect(reconcile.env?.DEPLOY_BRANCH_DIR).toBe(
      "${{ github.workspace }}/deploy-branch"
    );
    expect(reconcile.env?.GH_TOKEN).toBe(
      "${{ steps.deploy-app.outputs.token || github.token }}"
    );
    expect(promote.if).toContain("scheduler-worker");
    expect(promote.run).toContain("NODES=scheduler-worker");
    expect(push.run?.match(/git push /g)).toHaveLength(1);
    expect(genericPrepare.if).toBe("matrix.node != 'scheduler-worker'");
    expect(genericSync.if).toBe("matrix.node != 'scheduler-worker'");
    expect(genericPush.if).toBe("matrix.node != 'scheduler-worker'");
    expect(
      parsed.jobs["reconcile-scheduler-worker-routing"].concurrency?.group
    ).toBe("reconcile-scheduler-worker-routing-candidate-a");
    expect(parsed.jobs.flight.needs).toContain(
      "reconcile-scheduler-worker-routing"
    );
    expect(parsed.jobs.flight.if).toContain(
      "needs.reconcile-scheduler-worker-routing.result == 'success'"
    );
  });

  it("never publishes shared scheduler routing before selected external preflight succeeds", () => {
    const routing = parsed.jobs["reconcile-scheduler-worker-routing"];
    expect(routing.needs).toEqual(["decide", "external-node-preflight"]);
    const condition = routing.if;
    if (!condition) throw new Error("routing job condition is required");
    // Evaluate the actual YAML condition, including the explicit cancellation
    // function. Hyphenated GitHub job identifiers use bracket syntax in JS.
    const expression = condition.replaceAll(
      "needs.external-node-preflight",
      'needs["external-node-preflight"]'
    );
    const cases = [
      {
        label: "external success",
        external: "true",
        result: "success",
        allowed: true,
      },
      {
        label: "external failure",
        external: "true",
        result: "failure",
        allowed: false,
      },
      {
        label: "external cancelled",
        external: "true",
        result: "cancelled",
        allowed: false,
      },
      {
        label: "external accidentally skipped",
        external: "true",
        result: "skipped",
        allowed: false,
      },
      {
        label: "external unknown",
        external: "true",
        result: "",
        allowed: false,
      },
      {
        label: "operator-only flight",
        external: "false",
        result: "skipped",
        allowed: true,
      },
      {
        label: "k3s service-only flight",
        external: "false",
        result: "skipped",
        allowed: true,
      },
      {
        label: "no-external failed preflight",
        external: "false",
        result: "failure",
        allowed: false,
      },
      {
        label: "missing selected-set output",
        external: "",
        result: "skipped",
        allowed: false,
      },
      {
        label: "cancelled workflow after successful preflight",
        external: "true",
        result: "success",
        cancelled: true,
        allowed: false,
      },
      {
        label: "failed decide",
        external: "false",
        result: "skipped",
        decide: "failure",
        allowed: false,
      },
    ];
    for (const scenario of cases) {
      const allowed = runInNewContext(
        expression,
        {
          always: () => true,
          cancelled: () => scenario.cancelled === true,
          needs: {
            decide: {
              result: scenario.decide ?? "success",
              outputs: { has_external_compute_node_targets: scenario.external },
            },
            "external-node-preflight": { result: scenario.result },
          },
        },
        { timeout: 100 }
      );
      expect(allowed, scenario.label).toBe(scenario.allowed);
    }
    // The new dependency must not create a cycle through flight or substrate.
    const visiting = new Set<string>();
    const complete = new Set<string>();
    const visit = (name: string) => {
      if (complete.has(name)) return;
      expect(visiting.has(name), `workflow dependency cycle at ${name}`).toBe(
        false
      );
      const job = parsed.jobs[name];
      if (!job) throw new Error(`unknown workflow dependency ${name}`);
      visiting.add(name);
      const dependencies =
        typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
      for (const dependency of dependencies) visit(dependency);
      visiting.delete(name);
      complete.add(name);
    };
    for (const name of Object.keys(parsed.jobs)) visit(name);
    const reconcile = namedStep(
      "reconcile-scheduler-worker-routing",
      "Reconcile scheduler-worker routing (propagate to per-env deploy branch)"
    );
    expect(reconcile.env?.SWR_RECONCILE_FLIGHT_TARGETS_JSON).toBe(
      "${{ needs.decide.outputs.flight_targets_json }}"
    );
  });

  it("pins serialized node writers to trusted fail-closed maintenance checks", () => {
    const promote = yaml.parse(
      readFileSync(
        path.join(REPO_ROOT, ".github/workflows/promote-and-deploy.yml"),
        "utf8"
      )
    ) as { jobs: Record<string, WorkflowJob> };
    const helper =
      "python3 ../ci-src/scripts/ci/lib/maintenance-fence.py check .";
    const candidateGroups = ["prepare-substrate-deploy-branch", "flight"];
    for (const name of candidateGroups) {
      const job = parsed.jobs[name];
      expect(job.concurrency?.group).toBe(
        "flight-candidate-a-${{ matrix.node }}"
      );
      expect(job.concurrency?.["cancel-in-progress"]).toBe(false);
    }
    const promoteJob = promote.jobs["promote-k8s"];
    expect(promoteJob.concurrency?.group).toBe(
      "flight-${{ needs.decide.outputs.environment }}-${{ matrix.node }}"
    );
    expect(promoteJob.concurrency?.["cancel-in-progress"]).toBe(false);
    const prepare = namedStep(
      "prepare-substrate-deploy-branch",
      "Prepare deploy branch shape"
    );
    const candidateCheckout = namedStep(
      "flight",
      "Prepare per-node deploy branch workspace"
    );
    const candidatePush = namedStep(
      "flight",
      "Commit and push to per-node deploy branch"
    );
    const promotionCheckout = promoteJob.steps.find(
      (step) =>
        step.name ===
        "Prepare per-node deploy branch (bootstrap from umbrella if missing)"
    );
    const promotionPush = promoteJob.steps.find(
      (step) => step.name === "Commit and push"
    );
    if (!promotionCheckout || !promotionPush)
      throw new Error("ordinary promotion writer steps are required");
    for (const [label, step, checks] of [
      ["candidate prepare", prepare, 2],
      ["candidate checkout", candidateCheckout, 1],
      ["candidate push", candidatePush, 1],
      ["promotion checkout", promotionCheckout, 1],
      ["promotion push", promotionPush, 1],
    ] as const) {
      const run = step.run ?? "";
      expect(run, label).toContain("set -euo pipefail");
      expect(run, label).not.toMatch(
        /(?:if|test)\s+[^\n]*(?:-e|-f)[^\n]*maintenance-fence/
      );
      expect(step.env?.SOURCE_REPOSITORY, label).toBe(
        "${{ fromJSON(needs.decide.outputs.source_repository_by_target_json)[matrix.node] }}"
      );
      expect(step.env?.SOURCE_SHA, label).toMatch(
        /needs\.decide\.outputs\.(node_source_sha|source_sha_by_target_json)|steps\.digest\.outputs\.source_sha/
      );
      expect(step.env?.SOURCE_READ_TOKEN, label).toBe(
        "${{ secrets.GIT_READ_TOKEN || github.token }}"
      );
      const guardLines = run
        .split("\n")
        .filter((line) => line.includes(helper));
      expect(guardLines, label).toHaveLength(checks);
      for (const line of guardLines) {
        expect(line, label).not.toMatch(/\|\|\s*(true|:)(?:\s|$)/);
        // Ordinary delivery cannot supply an operation exception or mutate fence state.
        expect(line.trim(), label).toMatch(/maintenance-fence\.py check \.$/);
      }
      if (run.includes("git checkout -B")) {
        expect(run.indexOf(helper), label).toBeGreaterThan(
          run.lastIndexOf("git checkout -B")
        );
      }
      if (run.includes("git push origin")) {
        expect(run.lastIndexOf(helper), label).toBeLessThan(
          run.indexOf("git add -A")
        );
        expect(run.lastIndexOf(helper), label).toBeLessThan(
          run.indexOf("git push origin")
        );
      }
    }
    for (const job of [
      parsed.jobs["prepare-substrate-deploy-branch"],
      parsed.jobs.flight,
      promoteJob,
    ]) {
      const checkout = job.steps.find((step) => step.with?.path === "ci-src");
      expect(checkout?.with?.path).toBe("ci-src");
      expect(checkout?.with?.repository).toBeUndefined();
      expect([undefined, "${{ github.sha }}"]).toContain(checkout?.with?.ref);
      expect(job.steps.map((step) => step.run ?? "").join("\n")).not.toMatch(
        /maintenance-fence\.py (begin|audited|finish)/
      );
    }
    expect(
      parsed.jobs["external-node-preflight"].steps.some((step) =>
        (step.run ?? "").includes("maintenance-drain.mjs")
      )
    ).toBe(false);
  });

  it("keeps every ordinary node outside shared native lifecycle and custody", () => {
    const reconcile = readFileSync(
      path.join(REPO_ROOT, "scripts/ci/reconcile-node-substrate.sh"),
      "utf8"
    );
    const runner = readFileSync(
      path.join(REPO_ROOT, "scripts/ci/run-node-substrate.sh"),
      "utf8"
    );
    const materialize = readFileSync(
      path.join(REPO_ROOT, "scripts/ci/secret-materialize.sh"),
      "utf8"
    );
    expect(reconcile).not.toMatch(
      /up -d (?:postgres|doltgres)|force-recreate|dolt_mirror_reconcile|DOLT_CREDS_|DOLTHUB_/
    );
    expect(reconcile).not.toMatch(
      /touch .*runtime_env|mv -f .*runtime_env|install_exact .*doltgres_install_creds/
    );
    expect(
      reconcile.match(/--profile bootstrap run --rm --no-deps/g)
    ).toHaveLength(2);
    expect(reconcile).toContain(
      "bao_get_field operator DOLTGRES_PASSWORD owner"
    );
    for (const source of [runner, reconcile]) {
      expect(source).toContain(
        'deployment_provider_for_target "$TARGET_NODE" "$DEPLOY_ENVIRONMENT"'
      );
      expect(source).toContain(
        "requested provider disagrees with owning catalog"
      );
      expect(source).not.toContain("native_preservation");
      expect(source).not.toContain("node-template");
    }
    expect(materialize).not.toContain("node-template");
    expect(materialize).toContain('bao_get_field "$inherit_from" "$k" owner');
    const guard = readFileSync(
      path.join(REPO_ROOT, "scripts/ci/lib/maintenance-fence.py"),
      "utf8"
    );
    expect(guard).not.toMatch(
      /check_qualification|claim_qualification|preserve_qualification/
    );
    expect(guard).toContain("maintenance_floor_not_on_main");
  });

  it("fails candidate verification unless worker /version matches SHA and digest", () => {
    const resolve = namedStep(
      "verify-candidate",
      "Resolve promoted scheduler-worker identity"
    );
    const wait = namedStep(
      "verify-candidate",
      "Wait for in-cluster services (per-node)"
    );

    expect(resolve.if).toContain("matrix.node == 'scheduler-worker'");
    expect(resolve.run).toContain(
      'json.load(handle).get("scheduler-worker", "")'
    );
    expect(resolve.run).toContain(".images[]");
    expect(wait.env?.SCHEDULER_EXPECTED_SHA).toBe(
      "${{ steps.scheduler-identity.outputs.sha }}"
    );
    expect(wait.env?.SCHEDULER_EXPECTED_DIGEST).toBe(
      "${{ steps.scheduler-identity.outputs.digest }}"
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

  it("reapplies shared platform settings at every candidate and promotion copy seam", () => {
    const prepare = namedStep(
      "prepare-substrate-deploy-branch",
      "Prepare deploy branch shape"
    );
    const sync = namedStep(
      "flight",
      "Sync base + per-node overlay + per-node catalog to deploy branch"
    );
    for (const step of [prepare, sync]) {
      expect(step.run).toContain("reconcile_shared_platform_manifests");
      expect(step.run).toContain(
        "ci-src/scripts/ci/lib/shared-platform-manifests.sh"
      );
    }
    expect(prepare.run).toContain(
      "bash ../ci-src/scripts/ci/promote-k8s-image.sh"
    );
    const routing = namedStep(
      "reconcile-scheduler-worker-routing",
      "Reconcile scheduler-worker routing (propagate to per-env deploy branch)"
    );
    expect(routing.env?.APP_SOURCE_DIR).toBe("${{ github.workspace }}/app-src");
    expect(routing.run).not.toContain("skipping routing reconcile");
    const promotion = yaml.parse(
      readFileSync(
        path.join(REPO_ROOT, ".github/workflows/promote-and-deploy.yml"),
        "utf8"
      )
    );
    const promotionSteps = Object.values(promotion.jobs).flatMap(
      (job) => (job as WorkflowJob).steps ?? []
    );
    const promotionSync = promotionSteps.find(
      (step) => step.name === "Sync infra/k8s + per-node catalog from app-src"
    );
    expect(promotionSync?.run).toContain("reconcile_shared_platform_manifests");
    const promote = promotionSteps.find(
      (step) => step.name === "Promote digest + record source-sha"
    );
    expect(promote?.run).toContain(
      "bash ../ci-src/scripts/ci/promote-k8s-image.sh"
    );
  });

  it("uses reviewed substrate scripts only for an exact in-repository self-flight", () => {
    const substrate = namedStep(
      "node-substrate",
      "Run node substrate (materialize -> reconcile)"
    ).run;

    expect(substrate).toBeTypeOf("string");
    expect(substrate).toContain(
      'substrate_runner="ci-src/scripts/ci/run-node-substrate.sh"'
    );
    expect(substrate).toContain(
      'catalog="app-src/infra/catalog/${{ matrix.node }}.yaml"'
    );
    expect(substrate).toContain(
      'source_repo="$(yq -N \'.source_repo // ""\' "$catalog")"'
    );
    expect(substrate).toContain(
      'if [ "$reliability_controller" = true ] && [ -z "$source_repo" ] && [ "$GITHUB_SHA" = "${{ needs.decide.outputs.head_sha }}" ]; then'
    );
    expect(substrate).not.toMatch(/matrix\.node.*operator/);
    expect(substrate).toContain('app_sha="$(git -C app-src rev-parse HEAD)"');
    expect(substrate).toContain('[ "$app_sha" = "$GITHUB_SHA" ]');
    expect(substrate).toContain(
      'substrate_runner="app-src/scripts/ci/run-node-substrate.sh"'
    );
    expect(substrate).toContain(
      'bash "$substrate_runner" candidate-a "${{ matrix.node }}"'
    );
  });

  it("preserves the deployed digest through the preliminary shape commit", () => {
    const prepare = namedStep(
      "prepare-substrate-deploy-branch",
      "Prepare deploy branch shape"
    ).run;

    expect(prepare).toBeTypeOf("string");
    const snapshot = prepare?.indexOf(
      'extract_overlay_image_ref candidate-a "$NODE"'
    );
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
    // bug.5139: the read is a single-target lib lookup, never the whole-fleet
    // snapshot piped into a filter — an early-exiting consumer SIGPIPEs the
    // producer, which runs `set -euo pipefail`, and the flight dies.
    expect(prepare).toContain("scripts/ci/lib/overlay-digest.sh");
    expect(prepare).not.toContain("snapshot-overlay-digests.sh");
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
