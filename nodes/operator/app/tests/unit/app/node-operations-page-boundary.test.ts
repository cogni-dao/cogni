// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Source-boundary regressions for the operations-first dashboard and node page. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../src");

function source(relative: string): string {
  return readFileSync(join(SRC_ROOT, relative), "utf8");
}

describe("node operations page boundary", () => {
  it("keeps personal AI activity separate and removes internal operations panels", () => {
    const dashboard = source("app/(app)/dashboard/view.tsx");
    expect(dashboard).toContain(">Dashboard</h1>");
    expect(dashboard).toContain("<span>Nodes</span>");
    expect(dashboard).toContain("Your AI usage");
    expect(dashboard.match(/<details/g)).toHaveLength(2);
    expect(dashboard).not.toContain("Your nodes");
    expect(dashboard).not.toContain("ProcessHealthEventContent");
    expect(dashboard).not.toContain("System Runs");
    expect(dashboard).not.toContain("Active Work");
  });

  it("uses one operations table with owner actions and no separate manage mode", () => {
    const page = source("app/(app)/nodes/[id]/page.tsx");
    const operations = source(
      "features/nodes/operations/NodeOperationsTable.client.tsx"
    );
    const deployments = source(
      "features/nodes/deployments/DeploymentEnvironmentMatrix.tsx"
    );
    expect(page).toContain('status === "active"');
    expect(page).toContain("<NodeOperationsDetail");
    expect(page).toContain("deploymentControls=");
    expect(page).toContain("<NodeWizard");
    expect(page).not.toContain("Manage node");
    expect(page).not.toContain("<details");
    expect(operations).toContain("<DeploymentEnvironmentMatrix");
    expect(operations).toContain("<NodeEnvToggle");
    expect(operations).not.toContain("-services");
    expect(deployments).toContain("Inside this deployment");
    expect(deployments).toContain("Sponsored compute");
  });

  it("keeps management cards on the same full-width detail grid", () => {
    const page = source("app/(app)/nodes/[id]/page.tsx");
    const access = source("features/nodes/access/NodeAccess.tsx");
    const distributions = source("features/nodes/DistributionsCard.client.tsx");
    const danger = source("features/nodes/ResetDaoDangerZone.client.tsx");

    expect(page).toContain('className={operationsNode ? "max-w-6xl" : ""}');
    expect(page).toContain('className="mt-6 w-full space-y-4"');
    for (const card of [access, distributions, danger]) {
      expect(card).not.toContain("max-w-2xl");
      expect(card).not.toContain("max-w-3xl");
    }
  });

  it("does not render the infrastructure placement selector", () => {
    const toggle = source(
      "features/nodes/deployments/NodeEnvToggle.client.tsx"
    );
    expect(toggle).not.toContain("<Select");
    expect(toggle).not.toContain("k3s");
    expect(toggle).not.toContain("Akash");
    expect(toggle).toContain('{inReach ? "Undeploy" : "Deploy"}');
  });
});
