// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/secrets/secrets-lane-trust.data`
 * Purpose: Which OpenBao lane prefixes an operator in a given environment may write.
 * Scope: pure data + one predicate. No IO, no env read — the caller supplies both envs.
 * Invariants:
 *   - DOWN_TRUST_ONLY: an operator may write its own lane and lanes BELOW it in trust.
 *     Up-trust is refused forever. This is the same direction as the reviewed actuator
 *     wallet cutover: custody flows down, never up.
 *   - EXPLICIT_TABLE_NOT_AN_ORDERING: the allowed set is written out per environment
 *     rather than derived from a rank comparison. `preview` may NOT write `candidate-a`
 *     even though candidate-a is "lower" — only the PAYING environment is a multi-lane
 *     custodian. An ordering would silently grant that; a table cannot.
 *   - ONE_VAULT_MANY_LANES: OpenBao is per-CLUSTER. The production operator writing
 *     `cogni/preview/<node>` writes into ITS OWN vault at a lane-labelled path — it is
 *     not a cross-cluster write and never reaches preview's vault. Per
 *     `secrets-management.md` Invariant 1 (PATH_CONVENTION_PER_SERVICE_PER_ENV) the
 *     blast-radius boundary is `<service>`; the env prefix is a lane label inside one
 *     vault, so widening the lane set does not widen that boundary.
 * Links: docs/spec/secrets-management.md, docs/design/node-self-serve-secrets.md,
 *   scripts/setup/provision-env-vm.sh (§5b.4d), scripts/setup/reconcile-env-substrate.sh
 * @public
 */

/** Deploy environments that own an OpenBao lane prefix (`cogni/<env>/…`). */
export type SecretsLane = "candidate-a" | "preview" | "production";

/**
 * Lanes each serving environment may custody, widest first.
 *
 * `production` is the multi-lane custodian because it is the PAYING cluster: the
 * Crossplane Composition interpolates every lane's secrets into the lease production's
 * Console account is billed for, so those values must live in production's own vault.
 * The alternative — production READING a pre-prod vault — inverts trust: a cluster that
 * runs unmerged control-plane trees would become the source of values production pays
 * for. Refused.
 */
export const SECRETS_LANE_TRUST: Readonly<
  Record<SecretsLane, readonly SecretsLane[]>
> = {
  production: ["candidate-a", "preview", "production"],
  preview: ["preview"],
  "candidate-a": ["candidate-a"],
};

/**
 * May an operator serving `servedEnv` write the `requestedEnv` lane prefix?
 * Unknown `servedEnv` ⇒ false (deny by default; a new environment opts in explicitly).
 */
export function canWriteSecretsLane(
  servedEnv: string,
  requestedEnv: string
): boolean {
  const allowed = SECRETS_LANE_TRUST[servedEnv as SecretsLane];
  return allowed !== undefined && allowed.includes(requestedEnv as SecretsLane);
}
