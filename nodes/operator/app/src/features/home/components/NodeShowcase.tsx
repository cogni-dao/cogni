// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/NodeShowcase`
 * Purpose: Homepage section that showcases live nodes as tiles + a "launch your own" CTA tile.
 * Scope: Presentational. Renders resolved showcase nodes passed from the server page. Does not fetch
 *   data or resolve hrefs.
 * Invariants: Token-only styling; each node tile links to its live homepage; the trailing tile routes
 *   to the formation wizard. Responsive grid.
 * Side-effects: none
 * Links: src/features/home/showcase/getShowcaseNodes.server.ts, src/app/(public)/page.tsx
 * @public
 */

import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  type LucideIcon,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Badge, Card, CardContent } from "@/components";
import { container, section } from "@/styles/ui";

import type { ResolvedShowcaseNode } from "../showcase/getShowcaseNodes.server";
import type { ShowcaseAccent, ShowcaseCategory } from "../showcase/nodes.data";

const ACCENT_BANNER: Record<ShowcaseAccent, string> = {
  blue: "bg-gradient-to-br from-primary/30 via-primary/10 to-transparent",
  emerald: "bg-gradient-to-br from-success/30 via-success/10 to-transparent",
  amber: "bg-gradient-to-br from-warning/30 via-warning/10 to-transparent",
  rose: "bg-gradient-to-br from-danger/30 via-danger/10 to-transparent",
};

const CATEGORY_ICON: Record<ShowcaseCategory, LucideIcon> = {
  platform: Boxes,
  app: Sparkles,
  hub: BookOpen,
};

const CATEGORY_LABEL: Record<ShowcaseCategory, string> = {
  platform: "Platform",
  app: "App",
  hub: "Knowledge Hub",
};

function NodeTile({ node }: { node: ResolvedShowcaseNode }): ReactElement {
  const Icon = CATEGORY_ICON[node.category];
  return (
    <Link
      href={node.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group block focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      <Card className="h-full overflow-hidden transition-shadow hover:shadow-lg">
        <div
          className={`flex h-28 items-center justify-center ${ACCENT_BANNER[node.accent]}`}
        >
          <Icon className="size-10 text-foreground/80" aria-hidden="true" />
        </div>
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-foreground text-lg">
              {node.title}
            </h3>
            <Badge intent="secondary" size="sm">
              {CATEGORY_LABEL[node.category]}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">{node.tagline}</p>
          <span className="inline-flex items-center font-medium text-primary text-sm">
            Visit
            <ArrowUpRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

function LaunchTile(): ReactElement {
  return (
    <Link
      href="/setup/dao"
      className="group block focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      <Card className="flex h-full items-center justify-center border-2 border-border border-dashed bg-transparent transition-colors hover:border-primary">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
            <Plus className="size-6" aria-hidden="true" />
          </span>
          <span className="font-semibold text-foreground text-lg">
            Launch your own
          </span>
          <span className="text-muted-foreground text-sm">
            Form a DAO and spin up a community-owned node.
          </span>
        </CardContent>
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
    <section className={section({ surface: "muted" })} id="nodes">
      <div className={container({ size: "lg", spacing: "lg" })}>
        <div className="mb-10 text-center">
          <h2 className="font-bold text-3xl text-foreground tracking-tight sm:text-4xl">
            Explore the network
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            Community-owned AI apps and knowledge hubs, built on Cogni — or
            launch your own.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node) => (
            <NodeTile key={node.name} node={node} />
          ))}
          <LaunchTile />
        </div>
      </div>
    </section>
  );
}
