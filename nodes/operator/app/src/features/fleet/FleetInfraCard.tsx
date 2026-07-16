// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/FleetInfraCard`
 * Purpose: The dashboard's lead card (story.5013 v0) — a Fleet/Infra view that replaces the old
 *   live-stream `process_health` card. SERVERS sub-card = compute-provider balances (client poll).
 *   NODES table = the REAL live network, sourced server-side from `NodeRegistryPort.listPublic()` (the
 *   same honest, cached, prod-live ∩ registry list the homepage/gallery render) and passed in as a
 *   prop — NOT a client per-node deploy-state fan-out (that was RBAC-403'd and rendered "live nowhere"
 *   for everything). Current-state only; no charts / uptime bars (vFuture).
 * Scope: Client island. SERVERS renders from a react-query hook (Skeleton/empty/error states). NODES
 *   is presentational over the injected, already-filtered list. No business logic, no metric emit.
 * Invariants: LIVE_ONLY (listPublic() = registry ∩ verified-live prod, so every row is live — no
 *   "live nowhere", no junk wizard nodes), PRIMARY_FIRST (operator/primary nodes sort first),
 *   REUSE_ONLY (existing shadcn Table + Badge primitives, no new dep), NO_RBAC_FANOUT (the registry is
 *   public + cached server-side, never per-node 403'd).
 * Side-effects: IO (SERVERS via the React Query hook only).
 * Links: ./use-fleet.ts, ./fleet-schemas.ts, src/ports/node-registry.port.ts (NodeSummary),
 *   GET /api/v1/compute/balances, story.5013
 * @public
 */

"use client";

import { Server } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import type { NodeSummary } from "@/ports";
import type { ComputeBalanceVM } from "./fleet-schemas";
import { useComputeBalances } from "./use-fleet";

/* ─── helpers ─── */

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// listPublic() returns ONLY nodes whose PRODUCTION host is verified-live (registry ∩ live-prod), so
// "live" here is the coarsest honest signal the registry carries: a live production deployment. Primary
// nodes (the one serving the bare apex, i.e. operator) sort first, then alphabetical by title.
function sortNodes(nodes: readonly NodeSummary[]): readonly NodeSummary[] {
  return [...nodes].sort((a, b) => {
    const ap = a.primary ? 0 : 1;
    const bp = b.primary ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.title.localeCompare(b.title);
  });
}

/* ─── SERVERS sub-card ─── */

function ServerBalanceRow({
  balance,
}: {
  balance: ComputeBalanceVM;
}): ReactElement {
  const runway =
    balance.estimatedDaysRemaining === null
      ? "runway unknown"
      : `${balance.estimatedDaysRemaining}d runway`;
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0">
        <p className="truncate font-medium text-sm">
          {balance.provider} · {balance.accountId}
        </p>
        <p className="text-muted-foreground text-xs">
          {relativeTime(balance.asOf)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-semibold text-sm tabular-nums">
          {balance.remaining.toLocaleString()} {balance.currency}
        </p>
        <p className="text-muted-foreground text-xs">
          {balance.estimatedDaysRemaining === null ? "—" : runway}
        </p>
      </div>
    </div>
  );
}

function ServersSection(): ReactElement {
  const { data, isLoading, isError } = useComputeBalances();

  return (
    <div>
      <h3 className="px-5 pb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        Servers
      </h3>
      {isLoading ? (
        <div className="space-y-2 px-5 py-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          Could not load compute balances.
        </p>
      ) : !data || data.length === 0 ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          No compute providers configured.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {data.map((balance) => (
            <ServerBalanceRow
              key={`${balance.provider}:${balance.accountId}`}
              balance={balance}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── NODES table ─── */

function NodeRow({ node }: { node: NodeSummary }): ReactElement {
  return (
    <TableRow>
      <TableCell className="font-medium text-sm">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-success" />
          <Link
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {node.title}
          </Link>
          {node.primary ? (
            <Badge intent="secondary" size="sm">
              Primary
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <Badge intent="default" size="sm">
          Production
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function NodesSection({
  nodes,
}: {
  nodes: readonly NodeSummary[];
}): ReactElement {
  const sorted = sortNodes(nodes);

  return (
    <div>
      <h3 className="px-5 pb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        Nodes
      </h3>
      {sorted.length === 0 ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          No live nodes yet.
        </p>
      ) : (
        <div className="px-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead className="text-right">Live</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((node) => (
                <NodeRow key={node.slug} node={node} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ─── lead card ─── */

export function FleetInfraCard({
  nodes,
}: {
  /** Live network from `NodeRegistryPort.listPublic()`, resolved server-side (cached, junk-filtered). */
  nodes: readonly NodeSummary[];
}): ReactElement {
  return (
    <Card>
      <CardHeader className="px-5 py-3">
        <CardTitle className="flex items-center gap-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          <Server className="size-3.5" />
          Fleet &amp; Infrastructure
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-0 pb-5">
        <ServersSection />
        <NodesSection nodes={nodes} />
      </CardContent>
    </Card>
  );
}
