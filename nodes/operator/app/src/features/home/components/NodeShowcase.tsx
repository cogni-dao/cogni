// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/NodeShowcase`
 * Purpose: Homepage section showcasing live nodes as clickable homepage-thumbnail tiles.
 * Scope: Presentational. Maps resolved NodeSummary → the shared NodeTile. Does not fetch data.
 * Invariants: Inherits the homepage background (no surface tint); each tile links to the node's live
 *   homepage in a new tab. Token-only styling. Responsive grid.
 * Side-effects: none
 * Links: src/features/nodes/components/NodeTile.tsx, src/app/(public)/page.tsx
 * @public
 */

import type { ReactElement } from "react";

import { NodeTile } from "@/features/nodes/components/NodeTile";
import type { NodeSummary } from "@/ports";

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
                href: node.href,
                external: true,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
