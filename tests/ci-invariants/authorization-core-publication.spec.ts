// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/authorization-core-publication`
 * Purpose: Pin the public authorization artifact's release and ownership boundary.
 * Scope: Static assertions over package metadata/source, repo policy, and publication workflow.
 * Invariants:
 *   - RELEASE_REQUIRES_POLICY_GATES: a main ancestor is insufficient; every repo-policy check passes on the tagged SHA.
 *   - PACKAGE_STAYS_CANONICAL: the artifact intentionally includes Cogni's OpenFGA adapter and SDK dependency.
 * Side-effects: IO (reads committed JSON, TypeScript, and workflow YAML).
 * Links: task.5224, packages/authorization-core, .github/workflows/publish-authorization-core.yml
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");

const workflowText = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-authorization-core.yml"),
  "utf8"
);
const workflow = yaml.parse(workflowText) as {
  readonly jobs: {
    readonly "release-tag": {
      readonly steps: readonly {
        readonly name?: string;
        readonly run?: string;
      }[];
    };
    readonly publish: {
      readonly steps: readonly {
        readonly name?: string;
        readonly run?: string;
      }[];
    };
  };
};
const policy = JSON.parse(
  readFileSync(path.join(REPO_ROOT, ".cogni/repo-policy.json"), "utf8")
) as {
  readonly ruleset: {
    readonly requiredStatusChecks: { readonly contexts: readonly string[] };
  };
};
const packageJson = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "packages/authorization-core/package.json"),
    "utf8"
  )
) as {
  readonly private?: boolean;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};
const packageIndex = readFileSync(
  path.join(REPO_ROOT, "packages/authorization-core/src/index.ts"),
  "utf8"
);
const requiredCheckScript = readFileSync(
  path.join(REPO_ROOT, "scripts/ci/assert-repo-policy-checks.sh"),
  "utf8"
);
const nodeAppConfig = readFileSync(
  path.join(REPO_ROOT, "infra/k8s/base/node-app/configmap.yaml"),
  "utf8"
);
const nodeMaterialization = readFileSync(
  path.join(REPO_ROOT, "scripts/setup/lib/reconcile-secrets.sh"),
  "utf8"
);

function namedStep(name: string): { readonly run?: string } {
  const step = [
    ...workflow.jobs["release-tag"].steps,
    ...workflow.jobs.publish.steps,
  ].find((candidate) => candidate.name === name);
  expect(step, `${name} step must exist`).toBeDefined();
  return step as { readonly run?: string };
}

describe("authorization-core publication", () => {
  it("requires every repo-policy check on the exact tagged commit", () => {
    expect(policy.ruleset.requiredStatusChecks.contexts).toEqual([
      "unit",
      "component",
      "static",
      "manifest",
    ]);
    const gate = namedStep(
      "Tagged commit must have passed every required check"
    ).run;
    expect(gate).toContain("assert-repo-policy-checks.sh");
    expect(requiredCheckScript).toContain(".cogni/repo-policy.json");
    expect(requiredCheckScript).toContain("commits/${COMMIT_SHA}/check-runs");
    expect(requiredCheckScript).toContain('run.status === "completed"');
    expect(requiredCheckScript).toContain('run.conclusion === "success"');
  });

  it("creates release tags only through the governed main-tip dispatch", () => {
    const mainGate = namedStep("Dispatch must target the exact main tip").run;
    const tagStep = namedStep(
      "Create immutable release tag with governed authority"
    ).run;
    expect(mainGate).toContain('GITHUB_REF" != "refs/heads/main');
    expect(mainGate).toContain('GITHUB_SHA" != "$main_sha');
    expect(tagStep).toContain("ACTIONS_AUTOMATION_BOT_PAT is required");
    expect(tagStep).toContain("refs/tags/${tag}");
  });

  it("publishes the existing adapter-bearing package rather than a shadow contract", () => {
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.dependencies?.["@openfga/sdk"]).toBe("0.9.6");
    expect(packageIndex).toContain("OpenFgaAuthorizationAdapter");
  });

  it("does not expose the shared OpenFGA authority to node apps", () => {
    expect(nodeAppConfig).not.toContain("OPENFGA_");
    expect(nodeMaterialization).not.toContain("OPENFGA_");
  });
});
