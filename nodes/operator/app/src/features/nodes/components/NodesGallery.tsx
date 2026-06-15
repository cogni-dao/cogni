// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodesGallery`
 * Purpose: Public network gallery layout for Cogni nodes.
 * Scope: Presentational composition over supplied node metrics and call-to-action slot.
 * Side-effects: none
 * Links: src/app/(public)/explore/nodes/page.tsx
 * @public
 */

import type { ReactElement, ReactNode } from "react";

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
  readonly callToAction: ReactNode;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value
  );
}

export function NodesGallery({
  items,
  callToAction,
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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-12 sm:px-6 md:py-16">
      <header className="mx-auto max-w-3xl text-center">
        <h1 className="font-bold text-4xl tracking-tight sm:text-5xl">
          Explore the network
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Community-owned AI apps, with public activity and ownership signals.
        </p>
        <p className="mt-5 text-muted-foreground text-sm">
          {formatNumber(nodeCount)} listed · {formatNumber(devActivity30d)}{" "}
          tracked events in 30d · {formatNumber(finalizedEpochs)} finalized
          epochs
        </p>
      </header>

      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <NodeNetworkCard
            key={item.node.slug}
            node={item.node}
            metrics={item.metrics}
          />
        ))}
      </section>

      <section className="border-border border-t pt-12 text-center">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-5">
          <div className="space-y-2">
            <h2 className="font-semibold text-3xl tracking-tight">
              Start a node
            </h2>
            <p className="text-muted-foreground">
              Launch a community-owned AI app with the guided node formation
              flow.
            </p>
          </div>
          {callToAction}
        </div>
      </section>
    </div>
  );
}
