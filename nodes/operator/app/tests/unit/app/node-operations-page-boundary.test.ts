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

  it("uses operations first only for active nodes and preserves owner actions under Manage", () => {
    const page = source("app/(app)/nodes/[id]/page.tsx");
    expect(page).toContain('status === "active"');
    expect(page).toContain("<NodeOperationsDetail node={operationsNode} />");
    expect(page).toContain("<NodeWizard");
    expect(page).toContain("Manage node");
    expect(page).toContain(
      "<NodeDeployments nodeId={node.id} envs={deployEnvs} />"
    );
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
