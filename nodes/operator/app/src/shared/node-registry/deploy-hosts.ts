// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/deploy-hosts`
 * Purpose: Pure, layer-neutral derivation of the PUBLIC host a node serves at PER deploy env, plus the
 *   canonical deploy-env set + guard. Lives in `shared` so BOTH the flight-status feature (route layer)
 *   and the deploy adapter / bootstrap factory (which cannot import `features`) consume one source of
 *   truth — no per-layer copy of the env→subdomain convention.
 * Scope: Host-string math only. No I/O, no env read.
 * Invariants:
 *   - HOST_CONVENTION: candidate-a serves `<host>-test`, preview `<host>-preview`, production bare;
 *     mirrors hostForNode() (resolve.ts) for the primary/non-primary split.
 *   - SINGLE_DEPLOY_ENV_SET: FLIGHT_ENVS is the one list; re-derive nothing locally.
 *   - LAYER_NEUTRAL: `shared` cannot import `ports`, so `FlightEnv` is defined here from FLIGHT_ENVS;
 *     `ports/node-flight.port.ts` mirrors the identical union (one literal set, two convergent decls).
 * Side-effects: none (pure)
 * Links: src/shared/node-registry/resolve.ts (hostForNode), src/features/nodes/flight-status.ts
 *   (re-exports these), src/ports/node-flight.port.ts (FlightEnv mirror)
 * @public
 */

/** The three deploy envs a node flights through. Mirrors RENDER_ENVS (node-app-scaffold/gens/appset.ts). */
export const FLIGHT_ENVS = ["candidate-a", "preview", "production"] as const;

/** One deploy env. Structurally identical to `@/ports` FlightEnv (shared cannot import ports). */
export type FlightEnv = (typeof FLIGHT_ENVS)[number];

/** Canonical guard for the deploy-env set — reuse instead of re-deriving a local env list. */
export function isFlightEnv(v: string | null): v is FlightEnv {
  return v !== null && (FLIGHT_ENVS as readonly string[]).includes(v);
}

/** candidate-a serves at `<host>-test`, preview at `<host>-preview`, production bare. */
const ENV_SUBDOMAIN: Record<FlightEnv, string> = {
  "candidate-a": "test",
  preview: "preview",
  production: "",
};

/**
 * Derive the public host a node serves at, per env. Primary node (operator) serves the env apex
 * (test./preview./bare); others prefix the slug (`<slug>-test.<base>`, prod `<slug>.<base>`).
 */
export function hostForEnv(
  slug: string,
  primary: boolean,
  env: FlightEnv,
  baseDomain: string
): string {
  const sub = ENV_SUBDOMAIN[env];
  if (primary) return sub ? `${sub}.${baseDomain}` : baseDomain;
  return sub ? `${slug}-${sub}.${baseDomain}` : `${slug}.${baseDomain}`;
}

/**
 * The verifier probes ALL envs (test./preview./bare), so it needs the ROOT zone, not the operator's
 * own env apex. Strip a leading env subdomain: `test.cognidao.org` / `preview.cognidao.org` → `cognidao.org`.
 */
export function rootDomain(apex: string): string {
  return apex.replace(/^(test|preview)\./, "");
}
