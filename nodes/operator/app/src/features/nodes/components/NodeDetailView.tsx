// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodeDetailView`
 * Purpose: Public detail layout for one Cogni node's transparency read model.
 * Scope: Presentational only. Shows supplied metrics, links, and ownership summary rows.
 * Side-effects: none
 * Links: src/app/(public)/nodes/[slug]/page.tsx
 * @public
 */

import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Brain,
  Coins,
  Github,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import type { NodeSummary } from "@/ports";

interface DetailMetrics {
  readonly devActivity30d: number;
  readonly devActivityTotal: number;
  readonly aiUsage:
    | { readonly state: "available"; readonly requests30d: number }
    | { readonly state: "unavailable"; readonly reason: string };
  readonly latestEpoch: {
    readonly id: string;
    readonly status: "open" | "review" | "finalized";
    readonly periodStart: string;
    readonly periodEnd: string;
  } | null;
  readonly finalizedEpochCount: number;
}

interface OwnerSummary {
  readonly claimantKey: string;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly isLinked: boolean;
  readonly totalCredits: number;
  readonly ownershipPercent: number;
  readonly epochsContributed: number;
}

export interface NodeDetailViewProps {
  readonly node: NodeSummary;
  readonly metrics: DetailMetrics;
  readonly topOwners: readonly OwnerSummary[];
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value
  );
}

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon: ReactElement;
}): ReactElement {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold text-2xl">{value}</div>
          <div className="truncate text-muted-foreground text-xs">{title}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function NodeDetailView({
  node,
  metrics,
  topOwners,
}: NodeDetailViewProps): ReactElement {
  const latestEpochRange = metrics.latestEpoch
    ? `${new Date(metrics.latestEpoch.periodStart).toLocaleDateString()} to ${new Date(
        metrics.latestEpoch.periodEnd
      ).toLocaleDateString()}`
    : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-4">
          <Link href="/nodes">
            <ArrowLeft className="size-4" />
            Nodes
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="mb-2 font-bold text-4xl tracking-tight">
              {node.title}
            </h1>
            {node.tagline ? (
              <p className="max-w-2xl text-lg text-muted-foreground">
                {node.tagline}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {node.href !== "#" ? (
              <Button asChild>
                <a href={node.href} target="_blank" rel="noopener noreferrer">
                  Visit
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
            ) : null}
            {node.repo ? (
              <Button asChild variant="secondary">
                <a
                  href={node.repo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github className="size-4" />
                  Repo
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Activity className="size-5" />}
          title="30d tracked events"
          value={formatNumber(metrics.devActivity30d)}
        />
        <StatCard
          icon={<Activity className="size-5" />}
          title="All tracked events"
          value={formatNumber(metrics.devActivityTotal)}
        />
        <StatCard
          icon={<Brain className="size-5" />}
          title="30d AI usage"
          value={
            metrics.aiUsage.state === "available"
              ? formatNumber(metrics.aiUsage.requests30d)
              : "Unavailable"
          }
        />
        <StatCard
          icon={<Coins className="size-5" />}
          title="Finalized epochs"
          value={formatNumber(metrics.finalizedEpochCount)}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Epoch</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.latestEpoch ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">
                    Epoch #{metrics.latestEpoch.id}
                  </span>
                  <Badge>{metrics.latestEpoch.status}</Badge>
                </div>
                {latestEpochRange ? (
                  <p className="text-muted-foreground text-sm">
                    {latestEpochRange}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No epoch data is available for this node yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI Usage</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.aiUsage.state === "available" ? (
              <p className="font-semibold text-2xl">
                {formatNumber(metrics.aiUsage.requests30d)}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                {metrics.aiUsage.reason}
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Ownership</CardTitle>
        </CardHeader>
        <CardContent>
          {topOwners.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No finalized ownership rows are available for this node yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead>Contributor</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Ownership</TableHead>
                  <TableHead className="text-right">Epochs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topOwners.map((owner, index) => (
                  <TableRow key={owner.claimantKey}>
                    <TableCell className="text-center text-muted-foreground text-xs">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex size-7 items-center justify-center rounded-full bg-muted text-sm">
                          {owner.displayName?.charAt(0).toUpperCase() ?? "C"}
                        </div>
                        <span className="font-medium text-sm">
                          {owner.displayName ?? "Contributor"}
                        </span>
                        {!owner.isLinked ? (
                          <Badge intent="outline" size="sm">
                            Unlinked
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNumber(owner.totalCredits)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {owner.ownershipPercent}%
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {owner.epochsContributed}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
