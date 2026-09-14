// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/platform-services`
 * Purpose: Operator-image mirror of the non-node PLATFORM SERVICES that own their own
 *   OpenBao bucket `cogni/<env>/<service>/*`, plus the node that administers them.
 *   Lets the self-serve write route address a platform-service path without inventing
 *   a second allowlist.
 * Scope: Data + two predicates. Decides nothing about authorization — the route still
 *   runs the per-node OpenFGA check first and this module only narrows what an already
 *   authorized caller may target. No catalog read (the operator image ships no catalog).
 * Invariants:
 *   - MIRROR_NOT_SECOND_SOURCE: `PLATFORM_SERVICES` and `PLATFORM_SERVICE_OWNER_NODE`
 *     restate `scripts/lib/secrets-catalog-loader.ts` + `scripts/setup/lib/reconcile-secrets.sh`
 *     + `scripts/ci/secret-materialize.sh`. The operator image carries no `scripts/` tree, so
 *     the values are restated here and pinned by a parity test, never re-derived.
 *   - MEMBERSHIP_IS_A_SECURITY_BOUNDARY: a name here declares an OpenBao path an
 *     authorized caller may write outside its own node's namespace. Adding one widens
 *     the owner node's secrets grant, so it belongs in a reviewed PR with a stated
 *     blast radius — never as a convenience.
 *   - OWNER_NODE_ADMINISTERS: a platform service is not a node and holds no OpenFGA
 *     tuples of its own. Its bucket is administered by the `secrets_manager` of the
 *     owner node, which is the same leg that mints its `source: agent` keys in
 *     `secret-materialize.sh` (`PLATFORM_SERVICE_OWNER_NODE`).
 * Side-effects: none
 * Links: scripts/lib/secrets-catalog-loader.ts, scripts/ci/secret-materialize.sh,
 *   docs/spec/secrets-management.md
 * @public
 */

/**
 * The node whose `can_manage_secrets` grant administers every platform-service bucket.
 *
 * A platform service receives no node DNS, no node DB, and no OpenFGA tuples — so there
 * is no `platform_service:<name>` object to check against today. `secret-materialize.sh`
 * already resolves that by running the platform-service mint pass on ONE node's leg
 * (`PLATFORM_SERVICE_OWNER_NODE`, default `operator`); this route reuses that same
 * declared ownership edge rather than inventing a parallel authority.
 *
 * Tracked narrowing: a dedicated `platform_service` type with its own `secrets_manager`
 * relation is the correct end state. It needs an OpenFGA model change, which only reaches
 * an environment through `bootstrap-openfga.sh` inside `deploy-infra` — until that lands,
 * a check against a relation the env's model lacks fails closed as `503 authz_unavailable`.
 */
export const PLATFORM_SERVICE_OWNER_NODE = "operator";

/**
 * Non-node services with their own OpenBao bucket + ExternalSecret. Mirror of
 * `PLATFORM_SERVICES` in `scripts/lib/secrets-catalog-loader.ts`; drift is caught by
 * `tests/unit/shared/secrets/platform-services.parity.spec.ts`.
 */
export const PLATFORM_SERVICES: ReadonlySet<string> = new Set<string>([
  "akash-tx-actuator",
]);

/** Is `service` a declared platform-service bucket an owner-node caller may target? */
export function isPlatformService(service: string): boolean {
  return PLATFORM_SERVICES.has(service);
}

/** Does `nodeSlug` administer platform-service buckets? */
export function administersPlatformServices(nodeSlug: string): boolean {
  return nodeSlug === PLATFORM_SERVICE_OWNER_NODE;
}
