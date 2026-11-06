// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/substrate-ports`
 * Purpose: The ONE table of shared substrate ports (hub `service-type-registry`), read by the mesh
 *   policy derivation and, from slice T4, by the node app env injection (CD2: one derivation).
 * Scope: Constants and pure helpers. Does not perform IO.
 * Invariants:
 *   - ONE_PORT_TABLE: no other node-deploy module spells a substrate port. `node-app-env.ts` still holds
 *     literals until T4 (task.5431) switches it here; PR #3032 owns that file meanwhile.
 *   - REGISTRY_ONLY: a port that is not here is never granted on the mesh. The scheduler-worker health
 *     port (30900) is not a registry type; T4 adds a row or stops injecting it.
 * Side-effects: none
 * Links: mesh-policy.ts, node-app-env.ts, https://cognidao.org/knowledge/service-type-registry
 * @public
 */

export const SUBSTRATE_PORTS = {
  postgres: 5432,
  doltgres: 5435,
  redis: 6379,
  "ai-gateway": 4000,
  temporal: 7233,
} as const;

export type SubstrateType = keyof typeof SUBSTRATE_PORTS;

export const SUBSTRATE_PORT_SET: ReadonlySet<number> = new Set(
  Object.values(SUBSTRATE_PORTS)
);

/** The ports of the given substrate types, sorted and deduplicated. */
export const portsForTypes = (types: readonly SubstrateType[]): number[] =>
  [...new Set(types.map((t) => SUBSTRATE_PORTS[t]))].sort((a, b) => a - b);
