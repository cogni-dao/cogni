// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/deploy-workload-name`
 * Purpose: Keep the operator deploy contract's workload-name rule in step with repo-spec's manifest rule
 *   (task.5431): both refuse `-mesh-`, so no state password `nd-<id8>-<workload>` can match the attempt-key
 *   Secret delete allow-list `nd-<id8>-<workload>-mesh-<release uuid>-a<n>`.
 * Scope: Pure regex and schema checks.
 * Invariants: SAME_RULE: every sample is accepted or refused by both, identically.
 * Side-effects: none
 * Links: packages/repo-spec/src/workload-manifest.ts, src/contracts/deploy.workloads.v1.contract.ts,
 *   src/ports/node-mesh.port.ts
 * @internal
 */

import { WORKLOAD_NAME_RE } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  DEPLOY_WORKLOAD_NAME_RE,
  DeployWorkloadInputSchema,
} from "@/contracts/deploy.workloads.v1.contract";
import { MESH_ATTEMPT_SECRET_NAME_RE } from "@/ports";

const RELEASE = "11111111-2222-4333-8444-555555555555";
const SAMPLES = [
  ["canary", true],
  ["poly-app", true],
  ["mesh", true],
  ["app-mesh", true],
  ["meshy-app", true],
  ["x-mesh-y", false],
  ["db-mesh-1", false],
  ["a-mesh-", false],
  [`a-mesh-${RELEASE}-a1`, false],
  ["9canary", false],
  ["Canary", false],
] as const;

describe("workload name rule (task.5431)", () => {
  it("the deploy contract and the repo-spec manifest accept and refuse the same names", () => {
    expect(DEPLOY_WORKLOAD_NAME_RE.source).toBe(WORKLOAD_NAME_RE.source);
    for (const [name, ok] of SAMPLES) {
      expect(WORKLOAD_NAME_RE.test(name), name).toBe(ok);
      expect(DEPLOY_WORKLOAD_NAME_RE.test(name), name).toBe(ok);
      expect(
        DeployWorkloadInputSchema.safeParse({
          nodeId: "poly",
          env: "candidate-a",
          workload: name,
          sourceSha: "a".repeat(40),
        }).success,
        name
      ).toBe(ok);
    }
  });

  it("no admitted workload name makes a state password that the attempt-key delete allow-list matches", () => {
    for (const [name, ok] of SAMPLES) {
      if (!ok) continue;
      expect(MESH_ATTEMPT_SECRET_NAME_RE.test(`nd-4ff8eac1-${name}`)).toBe(
        false
      );
    }
    // The refused shape is exactly what the allow-list would have matched.
    expect(
      MESH_ATTEMPT_SECRET_NAME_RE.test(`nd-4ff8eac1-x-mesh-${RELEASE}-a1`)
    ).toBe(true);
  });
});
