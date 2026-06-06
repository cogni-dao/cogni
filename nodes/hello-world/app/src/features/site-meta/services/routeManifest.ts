// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/site-meta/routeManifest`
 * Purpose: Site-wide route manifest and types for meta endpoints and e2e testing.
 * Scope: Defines all public routes with tags. Does not include auth/private routes.
 * Invariants: Version remains stable; route paths match actual app structure.
 * Side-effects: none
 * Notes: Central source of truth for route discovery contracts.
 * Links: /meta/route-manifest endpoint, e2e a11y testing
 * @internal
 */

export type RouteTag = "public" | "auth" | "docs";

export interface RouteEntry {
  readonly path: string;
  readonly tags: readonly RouteTag[];
}

export interface RouteManifest {
  readonly version: 1;
  readonly routes: readonly RouteEntry[];
}

export const routeManifest: RouteManifest = {
  version: 1,
  routes: [
    { path: "/", tags: ["public"] },
    { path: "/docs", tags: ["public", "docs"] },
    { path: "/pricing", tags: ["public"] },
  ],
};
