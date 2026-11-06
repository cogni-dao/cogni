// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/substrate-ports`
 * Purpose: The ONE table of shared substrate ports (hub `service-type-registry`), read by the mesh
 *   policy derivation and, from slice T4, by the node app env injection (CD2: one derivation).
 * Scope: Constants and pure helpers. Does not perform IO.
 * Invariants:
 *   - ONE_PORT_TABLE: no other node-deploy module spells a substrate port. `node-app-env.ts` reads its
 *     ports here (task.5432); `node-app-env.test.ts` fails on a port literal in that file.
 *   - REGISTRY_ONLY: a port that is not in `SUBSTRATE_PORTS` is never granted on the mesh.
 *   - EGRESS_ONLY_IS_NOT_REGISTRY: `EGRESS_ONLY_PORTS` holds ports the egress transport injects today but
 *     the registry does not name. They are never granted on the mesh and never injected for a mesh
 *     attempt. They are deleted with the egress transport (deletion A).
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

/**
 * Ports the egress transport injects today that are NOT service-type registry rows (task.5432).
 * `scheduler-worker-health`: the shared scheduler-worker's health NodePort on the env VM
 * (`infra/k8s/base/scheduler-worker/service.yaml`). Its only node consumer is the app's `/readyz`, which
 * treats it as non-fatal on the default probe. Not in `SUBSTRATE_PORT_SET`, so never granted on the mesh.
 */
export const EGRESS_ONLY_PORTS = {
  "scheduler-worker-health": 30900,
} as const;
