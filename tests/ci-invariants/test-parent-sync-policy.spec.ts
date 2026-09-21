// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/test-parent-sync-policy`
 * Purpose: Pins the declared divergence policy that makes the test parent a near-1:1 CI/CD mirror rather than a fork sharing ancestry (task.5142).
 * Scope: Static structural test over the manifest and the compiled policy; does not clone the mirror or hit the network — that is the detector's job.
 * Invariants:
 *   DEFAULT_DENY_DIVERGENCE: shared CI/CD substrate (workflows, scripts, packages, the operator
 *     app, the catalog CONTRACT, base manifests) is mirrored unless declared — so a newly added
 *     canonical path is in scope the moment it lands, with no allowlist to update.
 *   PRESENCE_IS_NOT_CONTENT: roster-generated control-plane paths are `content_may_differ`, which
 *     suppresses the content check but NOT absence. This is the guarantee whose violation 422'd
 *     spawny-boi's env activation on an absent scheduler-routing patch.
 *   CONTENT_MAY_DIFFER_WINS: `content_may_differ` overrides a broader `omit_from_artifact`, so the
 *     control-plane rows nested inside a roster omission stay required.
 *   MISSING_MAY_BE_FATAL: the mirror declares `on_missing: fail`.
 *   NO_HUB_SECRETS_IN_THE_MIRROR: hub production/staging secret material is declared hub-only.
 * Side-effects: IO (reads .cogni/sync-manifest.yaml)
 * Links: docs/spec/repo-sync-contract.md, scripts/ci/lib/sync-policy.mjs,
 *        scripts/ci/sync-test-parent.mjs, .cogni/sync-manifest.yaml
 * @public
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS CI library, intentionally untyped (scripts layer, no build step).
import {
  compileArtifactPolicy,
  readManifest,
} from "../../scripts/ci/lib/sync-policy.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const manifest = readManifest(
  path.join(REPO_ROOT, ".cogni/sync-manifest.yaml")
);

const testParents = manifest.artifacts.filter(
  (a: { role?: string }) => a.role === "test-parent"
);

describe("test-parent divergence policy", () => {
  it("declares exactly one test parent — sync-test-parent.mjs refreshes one mirror", () => {
    expect(testParents).toHaveLength(1);
  });

  const policy = compileArtifactPolicy(manifest, testParents[0].repo);

  it("MISSING_MAY_BE_FATAL — an absent canonical path fails the detector", () => {
    expect(policy.onMissing).toBe("fail");
  });

  it("OWNER_APP_BOUNDARY_FAILS_CLOSED — test-org sync is pinned to cogni-operator-test", () => {
    expect(testParents[0]).toMatchObject({
      repo: "cogni-test-org/cogni-monorepo",
      github_app: { id: "3956976", slug: "cogni-operator-test" },
    });
  });

  it("masks the decoded key before output and never selects an App ID from secrets", () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/test-parent-sync.yml"),
      "utf8"
    );
    const mask = workflow.indexOf('echo "::add-mask::$private_key"');
    const output = workflow.indexOf(
      'echo "key=$private_key" >> "$GITHUB_OUTPUT"'
    );

    expect(mask).toBeGreaterThan(-1);
    expect(output).toBeGreaterThan(mask);
    expect(workflow).toContain("app-id: ${{ steps.target.outputs.app_id }}");
    expect(workflow).not.toContain("secrets.GH_REVIEW_APP_ID");
    expect(workflow).toContain(
      "ACTUAL_APP_SLUG: ${{ steps.app.outputs.app-slug }}"
    );
  });

  // DEFAULT_DENY_DIVERGENCE. These are the paths a test-specific reimplementation would live in;
  // every one of them must mirror byte-for-byte, so the mirror exercises the production lane.
  it.each([
    ".github/workflows/ci.yaml",
    ".github/workflows/candidate-flight.yml",
    ".github/workflows/promote-and-deploy.yml",
    "scripts/ci/render-scheduler-worker-endpoints.sh",
    "scripts/ci/render-node-appset.sh",
    "scripts/ci/lib/image-tags.sh",
    "infra/catalog/_schema.json",
    "infra/k8s/base/node-app/deployment.yaml",
    "infra/k8s/argocd/control-plane/roots/candidate-a-control-plane-application.yaml",
    "infra/crossplane/xcomputeworkload/composition.yaml",
    "nodes/operator/app/src/shared/node-app-scaffold/gens/env-membership-plan.ts",
    "packages/repo-spec/src/index.ts",
    ".cogni/sync-manifest.yaml",
  ])("mirrors shared CI/CD substrate 1:1 — %s", (p) => {
    expect(policy.hubDisposition(p)).toBe("mirror");
  });

  // PRESENCE_IS_NOT_CONTENT. `content_free` still REQUIRES the path; only its bytes are free.
  it.each([
    "infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml",
    "infra/k8s/overlays/preview/scheduler-worker/node-endpoints.patch.yaml",
    "infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml",
    "infra/k8s/overlays/production/operator/external-secret.yaml",
    "infra/k8s/argocd/appsets/candidate-a/kustomization.yaml",
    "infra/k8s/base/scheduler-worker/configmap.yaml",
    "infra/compose/edge/configs/Caddyfile.tmpl",
    "infra/catalog/operator.yaml",
    ".cogni/repo-spec.yaml",
  ])("requires the generated control-plane path, frees only its content — %s", (p) => {
    expect(policy.hubDisposition(p)).toBe("content_free");
  });

  // CONTENT_MAY_DIFFER_WINS — the control-plane cases above are nested inside these omissions.
  it.each([
    "infra/catalog/beacon.yaml",
    "infra/k8s/overlays/production/beacon/external-secret.yaml",
    "infra/k8s/argocd/appsets/production/production-beacon-applicationset.yaml",
  ])("treats the hub's own roster as hub-only — %s", (p) => {
    expect(policy.hubDisposition(p)).toBe("hub_only");
  });

  it("NO_HUB_SECRETS_IN_THE_MIRROR — hub production/staging material never flows out", () => {
    expect(
      policy.hubDisposition("infra/k8s/secrets/production/operator.enc.yaml")
    ).toBe("hub_only");
    expect(
      policy.hubDisposition("infra/k8s/secrets/staging/operator.enc.yaml")
    ).toBe("hub_only");
  });

  // REFRESH_IS_NOT_A_ROSTER_CHANGE — mirror-owned fixtures survive a content refresh.
  it.each([
    ".gitmodules",
    "nodes/spawny-boi",
    "infra/catalog/spawny-boi.yaml",
    "infra/k8s/argocd/candidate-a-operator-applicationset.yaml",
    "nodes/canary/app/package.json",
  ])("leaves the mirror's declared fixtures alone — %s", (p) => {
    expect(policy.isArtifactOnlyDeclared(p)).toBe(true);
  });

  it("does NOT treat retired hub source as a mirror fixture", () => {
    expect(
      policy.isArtifactOnlyDeclared(
        "nodes/operator/app/src/features/home/showcase/nodes.data.ts"
      )
    ).toBe(false);
  });
});
