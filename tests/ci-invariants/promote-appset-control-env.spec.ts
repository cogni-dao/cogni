// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/promote-appset-control-env`
 * Purpose: Pins the lane/control boundary for AppSet reconciliation during promote.
 * Scope: Static YAML read only. Does NOT dispatch workflows or access a cluster.
 * Invariants:
 *   - APPSET_IDENTITY_FOLLOWS_CONTROL_ENV: Akash reconciliation reads the fleet
 *     control environment's VM credentials, while k3s stays on the workload lane.
 *   - MISSING_CONTROL_VM_FAILS_CLOSED: a missing VM cannot turn reconciliation into
 *     a green no-op.
 *   - FOREIGN_LANES_ARE_APPLIED: the control cluster receives and refreshes the
 *     lane-named AppSet instead of returning a green no-op.
 * Side-effects: IO (reads the workflow file)
 * Links: task.5141, docs/spec/node-ci-cd-contract.md § Lane vs control env
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = path.resolve(
  __dirname,
  "../../.github/workflows/promote-and-deploy.yml"
);
const body = readFileSync(WORKFLOW, "utf8");
const reconcileJob = body.match(
  /^  reconcile-appset:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n)/m
)?.[0];

describe("promote AppSet control-env wiring (task.5141)", () => {
  it("binds Akash reconciliation to the fleet control environment", () => {
    expect(reconcileJob).toBeDefined();
    expect(reconcileJob).toContain(
      "environment: ${{ fromJSON(needs.decide.outputs.deployment_provider_by_target_json)[matrix.node] == 'akash' && (vars.FLEET_CONTROL_ENV || 'production') || needs.decide.outputs.environment }}"
    );
  });

  it("fails closed when the selected control environment has no VM", () => {
    expect(reconcileJob).toContain(
      "::error::VM_HOST is required for AppSet reconcile"
    );
    expect(reconcileJob).not.toContain("skipping AppSet reconcile");
  });

  it("applies and refreshes the lane AppSet", () => {
    expect(reconcileJob).toContain(
      "kubectl apply -f /tmp/appset-${DEPLOY_ENVIRONMENT}-${NODE}.yaml"
    );
    expect(reconcileJob).toContain(
      "annotate applicationset cogni-${DEPLOY_ENVIRONMENT}-${NODE}"
    );
    expect(reconcileJob).not.toContain(
      "its AppSet is owned by that cluster's app-of-apps. Skipping"
    );
  });
});
