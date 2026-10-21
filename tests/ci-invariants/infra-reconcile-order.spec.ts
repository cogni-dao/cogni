// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@tests/ci-invariants/infra-reconcile-order`
 * Purpose: Ensure normal shared-runtime repair is reachable before its dependencies.
 * Scope: Workflow DAG and normal deployment phase source. Does not access network or Docker.
 * Invariants: Operator/full recovery precedes consumers; legacy bootstrap retains ordering.
 * Side-effects: IO (reads committed workflow and script).
 * Links: story.5095, task.5281, scripts/ci/deploy-infra.sh
 * @internal
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const workflow = yaml.parse(
  readFileSync(
    path.join(root, ".github/workflows/promote-and-deploy.yml"),
    "utf8"
  )
) as {
  jobs: Record<
    string,
    { needs: string[]; if: string; env?: unknown; steps?: unknown }
  >;
};
const source = readFileSync(
  path.join(root, "scripts/ci/deploy-infra.sh"),
  "utf8"
);
const jobs = workflow.jobs;

describe("normal infrastructure reconciliation ordering", () => {
  it("repairs operator/full infra before custody and datastore consumers", () => {
    expect(jobs["deploy-infra"].needs).toEqual(["decide"]);
    expect(jobs["deploy-infra"].if).toContain("inputs.nodes == 'operator'");
    expect(jobs["deploy-infra"].if).toContain("inputs.skip_infra != 'true'");
    expect(jobs["deploy-infra"].if).toContain(
      "(inputs.deploy_infra_mode || 'full') == 'full'"
    );
    for (const name of [
      "node-substrate",
      "reconcile-appset",
      "reconcile-dns",
    ]) {
      expect(jobs[name].needs).toContain("deploy-infra");
      expect(jobs[name].if).toContain(
        "needs.deploy-infra.result == 'success' || needs.deploy-infra.result == 'skipped'"
      );
    }
  });
  it("retains fresh-node bootstrap and shares the infrastructure body", () => {
    const legacy = jobs["deploy-infra-legacy"];
    expect(legacy.needs).toEqual(["decide", "promote-k8s", "node-substrate"]);
    expect(legacy.if).toContain("!( inputs.nodes == 'operator'");
    expect(legacy.if).toContain("inputs.skip_infra != 'true'");
    expect(legacy.steps).toBe(jobs["deploy-infra"].steps);
    expect(legacy.env).toBe(jobs["deploy-infra"].env);
    for (const name of ["verify", "verify-deploy"]) {
      expect(jobs[name].needs).toContain("deploy-infra-legacy");
      expect(jobs[name].if).toContain(
        "needs.deploy-infra-legacy.result == 'success' || needs.deploy-infra-legacy.result == 'skipped'"
      );
    }
  });
  it("stops the watchdog before installed-env and custody reads", () => {
    const remote = source.slice(
      source.indexOf('cat > "$ARTIFACT_DIR/deploy-infra-remote.sh"')
    );
    const stop = remote.indexOf("  stop_runtime_watchdog\n");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(
      remote.indexOf("previous_runtime_env_value POSTGRES_ROOT_USER")
    );
    expect(stop).toBeLessThan(
      remote.indexOf(
        'PREVIOUS_OPENFGA_AUTHORIZATION_MODEL_ID="$(previous_runtime_env_value'
      )
    );
    expect(stop).toBeLessThan(
      remote.indexOf('OPERATOR_DATABASE_SERVICE_URL="$(openbao_get_field')
    );
    expect(remote).not.toContain("$RUNTIME_COMPOSE stop autoheal");
  });
});
