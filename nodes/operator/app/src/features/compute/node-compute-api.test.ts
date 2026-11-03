// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  isNodeOnDeployVerb,
  NODE_ON_DEPLOY_VERB,
  refuseNodeOnFlightPromoteLane,
} from "./node-compute-api";

describe("isNodeOnDeployVerb (task.5411: node-deploy is the only cell value)", () => {
  it("is true for a node-deploy cell and false for an absent one", () => {
    const catalog = { name: "poly", compute_api: { production: "node-deploy" } };
    expect(isNodeOnDeployVerb({ catalog, environment: "production" })).toBe(
      true
    );
    expect(isNodeOnDeployVerb({ catalog, environment: "preview" })).toBe(false);
    expect(
      isNodeOnDeployVerb({ catalog: { name: "operator" }, environment: "preview" })
    ).toBe(false);
  });

  it("THROWS on a deleted authority value instead of reading it as legacy", () => {
    for (const value of ["crossplane", "legacy"]) {
      expect(() =>
        isNodeOnDeployVerb({
          catalog: { name: "poly", compute_api: { production: value } },
          environment: "production",
        })
      ).toThrow(/Invalid catalog compute_api/);
    }
  });
});

describe("refuseNodeOnFlightPromoteLane (CD4 front door)", () => {
  it("admits only the operator", () => {
    expect(
      refuseNodeOnFlightPromoteLane({
        slug: "operator",
        lane: "flight",
        environment: "candidate-a",
      })
    ).toBeNull();
  });

  it("refuses every other node with node_on_deploy_verb and names the verb", () => {
    const refusal = refuseNodeOnFlightPromoteLane({
      slug: "poly",
      lane: "promote",
      environment: "production",
    });
    expect(refusal).toMatchObject({
      error: NODE_ON_DEPLOY_VERB,
      errorCode: NODE_ON_DEPLOY_VERB,
      deployVerb: "POST /api/v1/deploy/workloads",
    });
    expect(refusal?.message).toMatch(
      /promote refused: node_on_deploy_verb: poly in production/
    );
  });
});
