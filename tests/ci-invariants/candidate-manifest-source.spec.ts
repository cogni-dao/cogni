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
 *   CONTROL_DOMAIN_STAYS_SEPARATE: a test parent's Akash workload zone never
 *     replaces its explicitly configured k3s operator/control domain during
 *     substrate or public checks.
 *   DEPLOY_REPO_OWNS_APPSET: AppSet reconciliation renders repoURL for the
 *     repository that owns the deploy branch instead of the canonical default;
 *     writer, AppSet, verification checkout, and ancestry check share one resolver.
 *   ISOLATED_FLEET_ROOT_IS_LOCAL: a non-canonical candidate reconciles the
 *     apply-once control-plane root to its own protected main before AppSets.
 *   EXACT_SELF_FLIGHT_PROVES_SUBSTRATE_SCRIPTS: the operator may execute the
 *     reviewed app-source substrate runner only when workflow and app are the
 *     same commit; all remote or mismatched source flights stay on ci-src.
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

  it("reconciles an isolated fleet root before applying its AppSet", () => {
    const root = namedStep(
      "reconcile-appset",
      "Reconcile isolated fleet control-plane root"
    );

    expect(root.if).toBe("steps.ssh-setup.outputs.has_vm == 'true'");
    expect(root.run).toContain('== "cogni-dao/cogni"');
    expect(root.run).toContain(
      'desired_repo="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"'
    );
    expect(root.run).toContain(
      "targetRevision: deploy/candidate-a-control-plane#targetRevision: main"
    );
    expect(root.run).toContain(".status.operationState.phase");
    expect(root.run).toContain("|Healthy|Succeeded");
  });

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

  it("uses reviewed substrate scripts only for an exact operator self-flight", () => {
    const substrate = namedStep(
      "node-substrate",
      "Run node substrate (materialize -> reconcile)"
    ).run;

    expect(substrate).toBeTypeOf("string");
    expect(substrate).toContain(
      'substrate_runner="ci-src/scripts/ci/run-node-substrate.sh"'
    );
    expect(substrate).toContain(
      'if [ "${{ matrix.node }}" = "operator" ] && [ "$GITHUB_SHA" = "${{ needs.decide.outputs.head_sha }}" ]; then'
    );
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
