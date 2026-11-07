// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/authz` (test)
 * Purpose: Pin the per-env authority of the node-deploy verb (bug.5574). candidate-a is the developer
 *   proving lane (`node.flight`) AND stays open to env managers (`node.manage_envs`); preview is
 *   env-manager; production is production-promoter. The deploy-verb migration (story.5137) had swept
 *   candidate-a into `node.manage_envs` only, locking a developer out of proving their own PR.
 * Scope: The pure env->actions map and the decision reducer; the full gate's IO is in `route.test.ts`.
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { describe, expect, it } from "vitest";
import { authzActionsForEnv, gateDecisionFromResults } from "./authz";

describe("authzActionsForEnv", () => {
  it("lets a developer OR an env manager deploy candidate-a (bug.5574, additive)", () => {
    expect(authzActionsForEnv("candidate-a")).toEqual([
      "node.flight",
      "node.manage_envs",
    ]);
  });

  it("gates preview on node.manage_envs only (env manager)", () => {
    expect(authzActionsForEnv("preview")).toEqual(["node.manage_envs"]);
  });

  it("gates production on node.promote_production only (production promoter)", () => {
    expect(authzActionsForEnv("production")).toEqual([
      "node.promote_production",
    ]);
  });
});

describe("gateDecisionFromResults", () => {
  const allow = {
    decision: "allow",
    code: "authz_allowed" as AuthzDecisionCode,
  };
  const denied = {
    decision: "deny",
    code: "authz_denied" as AuthzDecisionCode,
  };
  const unavailable = {
    decision: "deny",
    code: "authz_unavailable" as AuthzDecisionCode,
  };

  it("allows when any action allows", () => {
    expect(gateDecisionFromResults([denied, allow])).toEqual({ ok: true });
    expect(gateDecisionFromResults([allow])).toEqual({ ok: true });
  });

  it("denies when every action is denied", () => {
    expect(gateDecisionFromResults([denied, denied])).toEqual({
      ok: false,
      code: "authz_denied",
    });
  });

  it("reports an outage over a clean denial (fail closed with distinction)", () => {
    expect(gateDecisionFromResults([denied, unavailable])).toEqual({
      ok: false,
      code: "authz_unavailable",
    });
  });
});
