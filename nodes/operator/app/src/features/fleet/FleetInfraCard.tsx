// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/FleetInfraCard`
 * Purpose: The dashboard's lead card (story.5013 v0) — a personal Fleet/Infra view that replaces the
 *   old live-stream `process_health` card. SERVERS sub-card = compute-provider balances; NODES grid =
 *   the viewer's own nodes with per-env (Test / Preview / Production) health, buildSha, replicas, and a
 *   live-envs rollup. Current-state only; no charts / uptime bars (vFuture).
 * Scope: Client island. Renders from the fleet react-query hooks; handles loading (Skeleton),
 *   empty, and error states gracefully. No business logic, no metric emit.
 * Invariants: PERSONAL_SCOPE (own nodes only — no all-nodes/fleet read), ON_DEMAND_READ (poll, never
 *   a gauge), REUSE_ONLY (existing shadcn primitives, no new dep), FULL_SHAPE (consumes the whole
 *   deploy-state cell so null-today fields enrich with zero UI change).
 * Side-effects: IO (via React Query hooks)
 * Links: ./use-fleet.ts, ./fleet-schemas.ts, GET /api/v1/compute/balances,
 *   GET /api/v1/nodes/[id]/deploy-state, story.5013
 * @public
 */

"use client";

import { Server } from "lucide-react";
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
import type {
  ComputeBalanceVM,
  DeployEnvVM,
  NodeFleetVM,
} from "./fleet-schemas";
import { useComputeBalances, useFleetNodes } from "./use-fleet";

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

// User-facing TIER (role), not the backend deploy-lane id: candidate-a → Test. Matches NodeDeployments.
const ENV_TIER: Record<string, string> = {
  "candidate-a": "Test",
  preview: "Preview",
  production: "Production",
};

const ENV_ORDER = ["candidate-a", "preview", "production"];

function tierLabel(env: string): string {
  return ENV_TIER[env] ?? env;
}

function sortEnvs(
  envs: readonly DeployEnvVM[]
): readonly DeployEnvVM[] {
  return [...envs].sort((a, b) => {
    const ai = ENV_ORDER.indexOf(a.env);
    const bi = ENV_ORDER.indexOf(b.env);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

// Badge intents available: default | secondary | destructive | outline (no success/warn). Pair a
// colored dot (true green via bg-success, matching the runs table) with the label badge.
const HEALTH_DOT: Record<DeployEnvVM["health"], string> = {
  healthy: "bg-success",
  degraded: "bg-destructive",
  provisioning: "bg-muted-foreground animate-pulse",
  unknown: "bg-muted-foreground",
};

const HEALTH_INTENT: Record<
  DeployEnvVM["health"],
  "default" | "secondary" | "destructive"
> = {
  healthy: "default",
  degraded: "destructive",
  provisioning: "secondary",
  unknown: "secondary",
};

const HEALTH_LABEL: Record<DeployEnvVM["health"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  provisioning: "Provisioning",
  unknown: "Unknown",
};

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

/* ─── NODES grid ─── */

function NodeEnvRow({ env }: { env: DeployEnvVM }): ReactElement {
  return (
    <TableRow>
      <TableCell className="font-medium text-sm">
        <span className="inline-flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${HEALTH_DOT[env.health]}`}
          />
          {tierLabel(env.env)}
        </span>
      </TableCell>
      <TableCell>
        <Badge intent={HEALTH_INTENT[env.health]} size="sm">
          {HEALTH_LABEL[env.health]}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">
        {env.buildSha ? env.buildSha.slice(0, 7) : "—"}
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-sm tabular-nums">
        {env.replicas.ready}/{env.replicas.desired}
      </TableCell>
    </TableRow>
  );
}

function NodeBlock({ node }: { node: NodeFleetVM }): ReactElement {
  const liveEnvs = node.deployState?.liveEnvs ?? [];
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <p className="truncate font-semibold text-sm">{node.slug}</p>
        {liveEnvs.length > 0 ? (
          <span className="shrink-0 text-muted-foreground text-xs">
            Live: {liveEnvs.map(tierLabel).join(", ")}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground text-xs">
            Live nowhere
          </span>
        )}
      </div>
      {node.error ? (
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          Deploy state unavailable ({node.error}).
        </p>
      ) : node.deployState && node.deployState.envs.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Build</TableHead>
              <TableHead className="text-right">Replicas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortEnvs(node.deployState.envs).map((env) => (
              <NodeEnvRow key={env.env} env={env} />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          No deploy environments yet.
        </p>
      )}
    </div>
  );
}

function NodesSection(): ReactElement {
  const { data, isLoading, isError } = useFleetNodes();

  return (
    <div>
      <h3 className="px-5 pb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        Nodes
      </h3>
      {isLoading ? (
        <div className="grid gap-3 px-5 sm:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : isError ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          Could not load your nodes.
        </p>
      ) : !data || data.length === 0 ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          You have no nodes yet.
        </p>
      ) : (
        <div className="grid gap-3 px-5 sm:grid-cols-2">
          {data.map((node) => (
            <NodeBlock key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── lead card ─── */

export function FleetInfraCard(): ReactElement {
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
        <NodesSection />
      </CardContent>
    </Card>
  );
}
