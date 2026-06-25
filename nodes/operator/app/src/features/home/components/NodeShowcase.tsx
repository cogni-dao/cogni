// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/NodeShowcase`
 * Purpose: Homepage section showcasing the node roster as clickable tiles, each rendered from the node's
 *   OWN self-described identity (title=hook, tagline=mission, thumbnail, brand color) + an honest
 *   live/down health badge. Plus a SEPARATE static "Launch your own" CTA tile — operator chrome, NOT a
 *   roster node (not probed, no health badge), pointing at node formation.
 * Scope: Presentational. Maps resolved NodeSummary → the shared NodeTile. Does not fetch data.
 * Invariants:
 *   - NO_OPERATOR_IDENTITY_LITERALS: roster tiles carry zero hardcoded node identity — every display
 *     field is passed through from the NodeSummary (the node's own well-known projection).
 *   - CTA_IS_CHROME: the "Launch your own" tile is operator chrome appended to the grid; it is not a
 *     roster entry and gets no health badge.
 *   - Inherits the homepage background (no surface tint); roster tiles link out in a new tab. Token-only
 *     styling (the brand-color tint is a per-node value the node itself supplies). Responsive grid.
 * Side-effects: none
 * Links: src/features/nodes/components/NodeTile.tsx, src/app/(public)/page.tsx
 * @public
 */

import type { ReactElement } from "react";

import { NodeTile } from "@/features/nodes/components/NodeTile";
import type { NodeSummary } from "@/ports";

/** Static "launch your own" call-to-action tile — operator chrome, not a roster node. */
const LAUNCH_CTA = {
  title: "Launch your own",
  tagline: "Fork this starter to spin up your own community-owned AI app.",
  href: "/nodes",
  external: false,
} as const;

export function NodeShowcase({
  nodes,
}: {
  nodes: readonly NodeSummary[];
}): ReactElement {
  return (
    <section
      className="w-full border-border border-t bg-background py-16 md:py-20"
      id="nodes"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 text-center">
          <h2 className="font-bold text-3xl text-foreground tracking-tight sm:text-4xl">
            Explore the network
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            Community-owned AI apps, built on Cogni.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node) => (
            <NodeTile
              key={node.slug}
              node={{
                title: node.title,
                tagline: node.tagline,
                thumbnailUrl: node.thumbnailUrl,
                brandColor: node.brandColor,
                href: node.href,
                external: true,
                health: node.health,
              }}
            />
          ))}
          {/* CTA_IS_CHROME: a static operator tile, not a probed roster node. */}
          <NodeTile node={LAUNCH_CTA} />
        </div>
      </div>
    </section>
  );
}
