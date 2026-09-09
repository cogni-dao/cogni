// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-address`
 * Purpose: The ONE seam that answers "what base URL does this operator dial to reach node `<slug>`?".
 *   Every operator→node internal client depends on this port instead of baking an address
 *   convention into its own module.
 * Scope: Interface only. No implementations, no I/O.
 * Invariants:
 *   - PLACEMENT_DECIDES_THE_ADDRESS: the answer is a function of the node's DECLARED deployment
 *     placement, not of the caller. A node placed on decentralized compute has no in-cluster
 *     Service, so a caller that assumes `http://<slug>-node-app:3000` is simply wrong (bug.5106).
 *   - NO_NODE_NAMES_IN_CODE: implementations read declared data; a node slug never appears in a
 *     branch. Adding or moving a node is a catalog edit, never an operator code change.
 *   - ADDRESS_IS_A_BASE: callers append their own path (`/api/internal/...`). No trailing slash.
 * Side-effects: none (interface only)
 * Links: src/adapters/server/node-registry/node-address.adapter.ts,
 *   src/shared/node-registry/placement.ts, src/adapters/server/ingestion/http-receipt-delivery.ts,
 *   src/adapters/server/ingestion/http-epochs-read.ts, bug.5106, story.5016
 * @public
 */

/** Failure contract for {@link NodeAddressPort} — an address that cannot be resolved is a fault. */
export class NodeAddressError extends Error {
  constructor(
    message: string,
    readonly slug: string
  ) {
    super(message);
    this.name = "NodeAddressError";
  }
}

export interface NodeAddressPort {
  /**
   * The base URL of a node's app for THIS environment, derived from that node's declared
   * placement. In-cluster nodes resolve to Service DNS; externally-placed nodes resolve to the
   * public host their workload publishes. Throws {@link NodeAddressError} when placement is
   * declared but no address can be derived — never returns a knowingly-unreachable address.
   */
  resolveNodeAppBaseUrl(slug: string): Promise<string>;
}
