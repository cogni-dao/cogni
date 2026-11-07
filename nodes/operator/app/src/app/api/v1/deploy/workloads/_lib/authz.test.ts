// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/authz` (test)
 * Purpose: Pin the per-env authority of the node-deploy verb (bug.5574). candidate-a is the developer
 *   proving lane (`node.flight`), preview is env-manager (`node.manage_envs`), production is
 *   production-promoter (`node.promote_production`). The deploy-verb migration (story.5137) had swept
 *   candidate-a into `node.manage_envs`, locking a developer out of proving their own PR.
 * Scope: The pure env->action map; the full gate's IO is covered by `route.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { authzActionForEnv } from "./authz";

describe("authzActionForEnv", () => {
  it("gates candidate-a on node.flight (the developer proving lane, bug.5574)", () => {
    expect(authzActionForEnv("candidate-a")).toBe("node.flight");
  });

  it("gates preview on node.manage_envs (env manager)", () => {
    expect(authzActionForEnv("preview")).toBe("node.manage_envs");
  });

  it("gates production on node.promote_production (production promoter)", () => {
    expect(authzActionForEnv("production")).toBe("node.promote_production");
  });
});
