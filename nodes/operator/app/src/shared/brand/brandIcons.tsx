// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/brand/brandIcons`
 * Purpose: Single registry mapping a repo-spec `intent.brand.icon` NAME (PascalCase
 *   Lucide name) to its component, plus a `<BrandIcon>` resolver. ONE place resolves
 *   a node's brand mark so the header, gallery card, og:image, and favicon all draw
 *   the same icon from the same source — no per-fork hand-coded AppHeader JSX.
 * Scope: Pure presentational + a name→component map. No data fetching, no repo-spec IO.
 * Invariants:
 *   - CURATED_SET: the network's chosen brand icons are bundled (keeps the icon payload
 *     tiny vs. importing all of lucide-react). Add a node's icon here when it declares
 *     a new `brand.icon` — the operator renders EVERY node's mark, so it carries the union.
 *   - SAFE_FALLBACK: an unknown/absent name renders the neutral `Hexagon` mark, never throws.
 * Side-effects: none
 * Links: src/app/.well-known/agent.json/route.ts, src/app/opengraph-image.tsx
 * @public
 */

import {
  Boxes,
  Brain,
  Crosshair,
  Gamepad2,
  GitFork,
  GitMerge,
  Hexagon,
  type LucideIcon,
  RadioTower,
  Shield,
  Sprout,
  Waypoints,
} from "lucide-react";

/** Curated brand-icon set — keyed by the PascalCase Lucide name stored in repo-spec. */
const BRAND_ICONS = {
  Boxes,
  Brain,
  Crosshair,
  Gamepad2,
  GitFork,
  GitMerge,
  RadioTower,
  Shield,
  Sprout,
  Waypoints,
} as const satisfies Record<string, LucideIcon>;

/** Neutral mark when a node has not declared `brand.icon` (or names an unbundled icon). */
export const FALLBACK_BRAND_ICON: LucideIcon = Hexagon;

/** Resolve a repo-spec `brand.icon` name to its Lucide component, or the neutral fallback. */
export function resolveBrandIcon(name: string | null | undefined): LucideIcon {
  if (!name) return FALLBACK_BRAND_ICON;
  return (
    (BRAND_ICONS as Record<string, LucideIcon>)[name] ?? FALLBACK_BRAND_ICON
  );
}

/**
 * `brand.icon` is polymorphic: a Lucide NAME or an image asset (a node's real logo, e.g. the Cogni
 * brain). The prober host-resolves image paths to absolute URLs, so by the time the gallery reads it an
 * image mark is an `http(s)` URL — render those via `<img>`, names via {@link resolveBrandIcon}.
 */
export function isBrandImageMark(
  icon: string | null | undefined
): icon is string {
  return typeof icon === "string" && /^https?:\/\//.test(icon);
}
