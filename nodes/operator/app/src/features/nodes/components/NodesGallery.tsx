// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodesGallery`
 * Purpose: Public network gallery layout for Cogni nodes.
 * Scope: Presentational composition over supplied node metrics and registration form slot.
 * Side-effects: none
 * Links: src/app/(public)/nodes/page.tsx
 * @public
 */

import { Activity, Boxes, Brain, Trophy } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components";
import type { NodeSummary } from "@/ports";

import { NodeNetworkCard } from "./NodeNetworkCard";

interface GalleryMetrics {
  readonly devActivity30d: number;
  readonly devActivityTotal: number;
  readonly aiUsage:
    | { readonly state: "available"; readonly requests30d: number }
    | { readonly state: "unavailable"; readonly reason: string };
  readonly latestEpoch: {
    readonly id: string;
    readonly status: "open" | "review" | "finalized";
  } | null;
  readonly finalizedEpochCount: number;
}

export interface NodesGalleryItem {
  readonly node: NodeSummary;
  readonly metrics: GalleryMetrics;
}

export interface NodesGalleryProps {
  readonly items: readonly NodesGalleryItem[];
  readonly registrationForm: ReactNode;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: ReactElement;
  label: string;
  value: string;
}): ReactElement {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold text-2xl">{value}</div>
          <div className="truncate text-muted-foreground text-xs">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function Leaderboard({
  title,
  items,
  valueFor,
}: {
  title: string;
  items: readonly NodesGalleryItem[];
  valueFor: (item: NodesGalleryItem) => number;
}): ReactElement {
  const ranked = [...items]
    .sort((a, b) => valueFor(b) - valueFor(a))
    .slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="size-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {ranked.map((item, index) => (
          <div key={item.node.slug} className="flex items-center gap-3 text-sm">
            <span className="w-8 shrink-0 text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 truncate font-medium">
              {item.node.title}
            </span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
              {formatNumber(valueFor(item))}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function NodesGallery({
  items,
  registrationForm,
}: NodesGalleryProps): ReactElement {
  const nodeCount = items.length;
  const devActivity30d = items.reduce(
    (sum, item) => sum + item.metrics.devActivity30d,
    0
  );
  const finalizedEpochs = items.reduce(
    (sum, item) => sum + item.metrics.finalizedEpochCount,
    0
  );
  const aiAvailable = items.filter(
    (item) => item.metrics.aiUsage.state === "available"
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="font-bold text-4xl tracking-tight sm:text-5xl">
          Cogni Nodes
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Public attribution, activity, and ownership views for community-owned
          AI apps.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<Boxes className="size-5" />}
          label="Listed nodes"
          value={formatNumber(nodeCount)}
        />
        <Stat
          icon={<Activity className="size-5" />}
          label="30d dev activity"
          value={formatNumber(devActivity30d)}
        />
        <Stat
          icon={<Brain className="size-5" />}
          label="AI usage feeds"
          value={`${aiAvailable}/${nodeCount}`}
        />
        <Stat
          icon={<Trophy className="size-5" />}
          label="Finalized epochs"
          value={formatNumber(finalizedEpochs)}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Leaderboard
          title="Dev Activity"
          items={items}
          valueFor={(item) => item.metrics.devActivity30d}
        />
        <Leaderboard
          title="Epochs Completed"
          items={items}
          valueFor={(item) => item.metrics.finalizedEpochCount}
        />
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <NodeNetworkCard
            key={item.node.slug}
            node={item.node}
            metrics={item.metrics}
          />
        ))}
      </section>

      <details className="group rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5">
          <div>
            <h2 className="font-semibold text-xl">Launch or Register Node</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Create the operator registry row, then continue through DAO
              formation and publish.
            </p>
          </div>
          <span className="text-muted-foreground text-sm group-open:hidden">
            Expand
          </span>
          <span className="hidden text-muted-foreground text-sm group-open:inline">
            Collapse
          </span>
        </summary>
        <div className="border-border border-t p-5">{registrationForm}</div>
      </details>
    </div>
  );
}
