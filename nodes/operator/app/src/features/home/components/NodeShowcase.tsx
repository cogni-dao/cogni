// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/NodeShowcase`
 * Purpose: Homepage section showcasing live nodes as clickable homepage-thumbnail tiles.
 * Scope: Presentational. Renders resolved showcase nodes passed from the server page. Does not fetch
 *   data or resolve hrefs.
 * Invariants: Inherits the homepage background (no surface tint); the entire tile is one link to the
 *   node's live homepage. Token-only styling. Responsive grid.
 * Side-effects: none
 * Links: src/features/home/showcase/getShowcaseNodes.server.ts, src/app/(public)/page.tsx
 * @public
 */

import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { Card } from "@/components";

import type { ResolvedShowcaseNode } from "../showcase/getShowcaseNodes.server";

function NodeTile({ node }: { node: ResolvedShowcaseNode }): ReactElement {
  return (
    <Link
      href={node.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group block rounded-lg"
    >
      <Card className="h-full overflow-hidden transition-colors group-hover:border-primary">
        <div className="relative aspect-video w-full overflow-hidden border-border border-b bg-muted">
          <Image
            src={node.thumbnail}
            alt={`${node.title} homepage`}
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover object-top transition-transform group-hover:scale-105"
          />
        </div>
        <div className="space-y-2 p-6">
          <h3 className="font-semibold text-foreground text-lg">
            {node.title}
          </h3>
          <p className="text-muted-foreground text-sm">{node.tagline}</p>
        </div>
      </Card>
    </Link>
  );
}

export function NodeShowcase({
  nodes,
}: {
  nodes: readonly ResolvedShowcaseNode[];
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
            <NodeTile key={node.name} node={node} />
          ))}
        </div>
      </div>
    </section>
  );
}
