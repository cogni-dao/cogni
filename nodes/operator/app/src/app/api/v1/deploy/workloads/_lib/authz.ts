// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/authz`
 * Purpose: The per-env authority of the node-deploy verb, as a pure policy (bug.5574).
 * Scope: No IO; the authorization checks themselves run in `./gate`.
 * Invariants:
 *   - candidate-a is the DEVELOPER proving lane. A principal who may open the PR must be able to
 *     deploy its head there and read the release back, so `node.flight` (`can_flight` <- developer)
 *     authorizes it — the same authority the retired `POST /api/v1/vcs/flight` candidate path used.
 *     `node.manage_envs` (env_manager) is ALSO accepted: env managers (and admins) could deploy
 *     candidate-a before the deploy-verb migration, so this stays additive, never a narrowing.
 *   - preview is the shared staging env -> `node.manage_envs` (the promote route's preview authority).
 *   - production -> `node.promote_production`.
 *   - ANY_ALLOWED_WINS / FAIL_CLOSED_WITH_DISTINCTION: a deploy is allowed if any of the env's actions
 *     allows. When none allows, an `authz_unavailable` (infra outage) is reported over an
 *     `authz_denied`, so an outage never masquerades as a clean denial.
 * @internal
 */

import type { AuthzAction, AuthzDecisionCode } from "@cogni/authorization-core";

/** The authz actions whose holder may act on the node-deploy verb for `env`; ALLOW on any one. */
export function authzActionsForEnv(
  env: "candidate-a" | "preview" | "production"
): readonly AuthzAction[] {
  switch (env) {
    case "production":
      return ["node.promote_production"];
    case "preview":
      return ["node.manage_envs"];
    case "candidate-a":
      return ["node.flight", "node.manage_envs"];
  }
}

/** The shape `./gate` reads from each `AuthorizationPort.check` result. */
type AuthzResult = { decision: string; code: AuthzDecisionCode };

/**
 * Collapse the per-action check results into one gate verdict: allow if any allowed; otherwise an
 * `authz_unavailable` outage over an `authz_denied`. `results` is never empty.
 */
export function gateDecisionFromResults(
  results: readonly AuthzResult[]
): { ok: true } | { ok: false; code: AuthzDecisionCode } {
  if (results.some((r) => r.decision === "allow")) return { ok: true };
  const unavailable = results.find((r) => r.code === "authz_unavailable");
  return {
    ok: false,
    code: unavailable ? unavailable.code : (results[0]?.code ?? "authz_denied"),
  };
}
