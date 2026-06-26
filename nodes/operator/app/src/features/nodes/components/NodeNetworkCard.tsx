// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodeNetworkCard`
 * Purpose: Public node gallery card with discovery copy and derived transparency metrics.
 * Scope: Presentational only. Metric values are supplied by the app facade.
 * Invariants: No data fetching; unknown metrics render explicitly as unavailable.
 * Side-effects: none
 * Links: src/app/_facades/nodes/gallery.server.ts
 * @public
 */

import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { Button, Card } from "@/components";
import type { NodeSummary } from "@/ports";
import { isBrandImageMark, resolveBrandIcon } from "@/shared/brand/brandIcons";

interface NodeCardMetrics {
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

export interface NodeNetworkCardProps {
  readonly node: NodeSummary;
  readonly metrics: NodeCardMetrics;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value
  );
}

function TileSignal({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="min-w-0">
      <div className="truncate text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 truncate font-medium text-foreground text-sm">
        {value}
      </div>
    </div>
  );
}

export function NodeNetworkCard({
  node,
  metrics,
}: NodeNetworkCardProps): ReactElement {
  const hasNodeMetrics = Boolean(node.nodeId);
  const activity = hasNodeMetrics
    ? `${formatNumber(metrics.devActivity30d)} / 30d`
    : "Not connected";
  const ownership = hasNodeMetrics
    ? metrics.finalizedEpochCount > 0
      ? `${formatNumber(metrics.finalizedEpochCount)} epochs`
      : "No epochs yet"
    : "Not connected";
  const aiUsage =
    metrics.aiUsage.state === "available"
      ? `${formatNumber(metrics.aiUsage.requests30d)} / 30d`
      : "Pending";
  // brand.icon is polymorphic: a hosted image (the node's real logo, e.g. the Cogni brain) or a Lucide
  // NAME. Image marks arrive host-resolved (http URL); names resolve to a Lucide component.
  const brandImage = isBrandImageMark(node.icon) ? node.icon : null;
  const BrandIcon =
    node.icon && !brandImage ? resolveBrandIcon(node.icon) : null;

  return (
    <Card className="flex h-full flex-col overflow-hidden transition-colors hover:border-primary">
      <Link
        href={`/explore/nodes/${node.slug}`}
        aria-label={`View ${node.title} details`}
        className="group flex flex-1 flex-col focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div className="relative aspect-video border-border border-b bg-muted">
          {brandImage ? (
            // IDENTITY_IS_REPO_SPEC_PROJECTION: the card mark is the node's own
            // `intent.brand.icon` — here a real hosted logo (e.g. the Cogni brain),
            // shown centered + contained (NOT a cover screenshot).
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted via-background to-background">
              <div className="relative h-3/5 w-3/5 transition-transform group-hover:scale-105">
                <Image
                  src={brandImage}
                  alt={`${node.title} logo`}
                  fill
                  unoptimized
                  sizes="(min-width: 1024px) 22vw, (min-width: 640px) 33vw, 60vw"
                  className="object-contain"
                />
              </div>
            </div>
          ) : BrandIcon ? (
            // A Lucide NAME mark, rendered big + brand-tinted.
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted via-background to-background">
              <BrandIcon
                className="size-24 transition-transform group-hover:scale-105"
                color={node.brandColor}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </div>
          ) : node.thumbnailUrl ? (
            <Image
              src={node.thumbnailUrl}
              alt={`${node.title} homepage`}
              fill
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              className="object-cover object-top transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/25 via-primary/10 to-transparent">
              <span className="font-bold text-4xl text-foreground/70 uppercase">
                {node.title.charAt(0)}
              </span>
            </div>
          )}
        </div>
        <div className="flex min-h-40 flex-1 flex-col gap-5 p-6">
          <div className="min-w-0 space-y-2">
            <h2 className="truncate font-semibold text-foreground text-lg">
              {node.title}
            </h2>
            {node.tagline ? (
              <p className="line-clamp-2 text-muted-foreground text-sm">
                {node.tagline}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-4 border-border border-t pt-4">
            <TileSignal label="Tracked" value={activity} />
            <TileSignal label="Ownership" value={ownership} />
            <TileSignal label="AI usage" value={aiUsage} />
          </div>
        </div>
      </Link>

      {node.href !== "#" ? (
        <div className="flex flex-wrap gap-2 px-6 pb-6">
          <Button asChild variant="secondary" size="sm">
            <a href={node.href} target="_blank" rel="noopener noreferrer">
              Visit app
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
