// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/authz`
 * Purpose: The per-env authority of the node-deploy verb, as a pure policy map (bug.5574).
 * Scope: No IO; the authorization check itself runs in `./gate`.
 * Invariants:
 *   - candidate-a is the DEVELOPER proving lane -> `node.flight` (`can_flight` <- developer). A principal
 *     who may open the PR must be able to deploy its head there and read the release back, the same
 *     authority the retired `POST /api/v1/vcs/flight` candidate path used.
 *   - preview is the shared staging env -> `node.manage_envs` (the promote route's preview authority).
 *   - production -> `node.promote_production`.
 * @internal
 */

import type { AuthzAction } from "@cogni/authorization-core";

export function authzActionForEnv(
  env: "candidate-a" | "preview" | "production"
): AuthzAction {
  switch (env) {
    case "production":
      return "node.promote_production";
    case "preview":
      return "node.manage_envs";
    case "candidate-a":
      return "node.flight";
  }
}
