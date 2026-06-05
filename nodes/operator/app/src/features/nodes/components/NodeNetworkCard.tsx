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

import { Activity, ArrowUpRight, Brain, GitBranch, Timer } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { Badge, Button, Card, CardContent } from "@/components";
import type { NodeSummary } from "@/ports";

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

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactElement;
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-md border bg-background p-3">
      <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate font-semibold text-sm">{value}</div>
    </div>
  );
}

export function NodeNetworkCard({
  node,
  metrics,
}: NodeNetworkCardProps): ReactElement {
  const aiUsage =
    metrics.aiUsage.state === "available"
      ? formatNumber(metrics.aiUsage.requests30d)
      : "Unavailable";
  return (
    <Card className="h-full overflow-hidden">
      <div className="relative aspect-video border-border border-b bg-muted">
        {node.thumbnailUrl ? (
          <Image
            src={node.thumbnailUrl}
            alt={`${node.title} homepage`}
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover object-top"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted">
            <span className="font-semibold text-5xl text-muted-foreground uppercase">
              {node.title.charAt(0)}
            </span>
          </div>
        )}
      </div>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="truncate font-semibold text-xl">{node.title}</h2>
            <Badge intent={node.kind === "full-app" ? "default" : "secondary"}>
              {node.kind === "full-app" ? "Node" : "Scope"}
            </Badge>
          </div>
          {node.tagline ? (
            <p className="line-clamp-2 min-h-10 text-muted-foreground text-sm">
              {node.tagline}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Metric
            icon={<Activity className="size-3.5" />}
            label="30d dev"
            value={formatNumber(metrics.devActivity30d)}
          />
          <Metric
            icon={<GitBranch className="size-3.5" />}
            label="All dev"
            value={formatNumber(metrics.devActivityTotal)}
          />
          <Metric
            icon={<Brain className="size-3.5" />}
            label="30d AI"
            value={aiUsage}
          />
          <Metric
            icon={<Timer className="size-3.5" />}
            label="Epochs"
            value={
              metrics.latestEpoch
                ? `${metrics.latestEpoch.status} #${metrics.latestEpoch.id}`
                : formatNumber(metrics.finalizedEpochCount)
            }
          />
        </div>

        <div className="mt-auto flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`/nodes/${node.slug}`}>Details</Link>
          </Button>
          {node.href !== "#" ? (
            <Button asChild variant="secondary" size="sm">
              <a href={node.href} target="_blank" rel="noopener noreferrer">
                Visit
                <ArrowUpRight className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
