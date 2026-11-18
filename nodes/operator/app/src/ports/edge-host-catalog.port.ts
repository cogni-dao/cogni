// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/edge-host-catalog`
 * Purpose: The catalog's edge application roster, read the way `scripts/ci/render-caddyfile.sh` reads it:
 *   every `type: node` catalog row that has a `node_port`, and whether it owns the bare operator domain
 *   (`is_primary_host`). The `edge.caught@1` calculator derives the hosts it probes from this roster plus
 *   the operator's own env domain (story.5148).
 * Scope: Interface + row type only. The image-catalog adapter implements it.
 * Invariants: CATALOG_IS_SSOT (the roster is the baked catalog, never a hardcoded host list).
 * Side-effects: none (interface)
 * Links: scripts/ci/render-caddyfile.sh, features/node-deploy/edge-caught-kpis.ts
 * @public
 */

export interface EdgeCatalogNode {
  /** The catalog file stem, e.g. `poly`. */
  readonly slug: string;
  /** `is_primary_host: true` (the operator): serves the bare env domain. */
  readonly primary: boolean;
}

export interface EdgeHostCatalogPort {
  /** Every catalog node the edge Caddy renders an application site for, sorted by slug. */
  edgeNodes(): Promise<readonly EdgeCatalogNode[]>;
}
