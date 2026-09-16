// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Compact, responsive operations home for nodes visible to the current principal. */

"use client";

import type { NodeOperationsOverview } from "@cogni/node-contracts";
import { HeaderFilter } from "@cogni/node-ui-kit/header-filter";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { cn } from "@cogni/node-ui-kit/util/cn";
import {
  type ColumnFiltersState,
  createColumnHelper,
  type ExpandedState,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  Rocket,
  Search,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { Card, CardContent, Input } from "@/components";
import { NodeBrandMark } from "@/features/nodes/components/NodeBrandMark";
import {
  DeploymentEnvironmentMatrix,
  type DeploymentEnvironmentRow,
} from "@/features/nodes/deployments/DeploymentEnvironmentMatrix";
import { formatComputeAmountsDisplay, sumComputeAmounts } from "./format-cost";
import { isObservedEnvironmentHealthy } from "./status";

type DeploymentStatus = Extract<
  NodeOperationsOverview["modules"]["deployment"],
  { state: "available" }
>["status"];

const STATUS = {
  healthy: {
    label: "Healthy",
    icon: CheckCircle2,
    className: "text-success",
  },
  deploying: {
    label: "Deploying",
    icon: Rocket,
    className: "text-primary",
  },
  needs_attention: {
    label: "Needs attention",
    icon: AlertCircle,
    className: "text-destructive",
  },
  not_deployed: {
    label: "Not deployed",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
  setting_up: {
    label: "Setting up",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
} satisfies Record<
  DeploymentStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
>;

function nodeStatusKey(node: NodeOperationsOverview): string {
  return node.modules.deployment.state === "available"
    ? node.modules.deployment.status
    : "unavailable";
}

function statusForNode(node: NodeOperationsOverview) {
  if (node.modules.deployment.state === "unavailable") {
    return {
      label: "Unavailable",
      icon: AlertCircle,
      className: "text-muted-foreground",
    };
  }
  return STATUS[node.modules.deployment.status];
}

function formatStatusFilter(value: string): string {
  if (value === "unavailable") return "Unavailable";
  return STATUS[value as DeploymentStatus]?.label ?? value;
}

function StatusLabel({ node }: { node: NodeOperationsOverview }): ReactElement {
  const status = statusForNode(node);
  const Icon = status.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        status.className
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {status.label}
    </span>
  );
}

function buildLabel(node: NodeOperationsOverview): string {
  if (node.modules.deployment.state === "unavailable") return "—";
  const production = node.modules.deployment.environments.find(
    (environment) => environment.env === "production"
  );
  return production?.buildSha?.slice(0, 7) ?? "—";
}

function hasServingProduction(node: NodeOperationsOverview): boolean {
  return (
    node.modules.deployment.state === "available" &&
    node.modules.deployment.environments.some(
      (environment) =>
        environment.env === "production" &&
        environment.declared &&
        isObservedEnvironmentHealthy(environment)
    )
  );
}

function computeLabel(node: NodeOperationsOverview): string {
  const compute = node.modules.compute;
  if (compute.state === "unavailable") return "Unavailable";
  if (compute.activeDeployments === 0 && compute.transferred.length === 0) {
    return "No compute";
  }
  return formatComputeAmountsDisplay(compute.transferred);
}

function environmentRows(
  node: NodeOperationsOverview
): DeploymentEnvironmentRow[] {
  const deployment = node.modules.deployment;
  if (deployment.state === "unavailable") return [];
  const compute = node.modules.compute;

  return deployment.environments.map((environment) => ({
    ...environment,
    compute:
      compute.state === "available" && compute.environment === environment.env
        ? {
            state: "available" as const,
            amount: formatComputeAmountsDisplay(compute.transferred),
            activeDeployments: compute.activeDeployments,
          }
        : { state: "unavailable" as const },
  }));
}

function GovernanceMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 truncate font-semibold text-sm tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function NodeDetails({
  node,
  showDetailLink = true,
  showHomepageLink = true,
  instanceId,
  disclosureId,
}: {
  node: NodeOperationsOverview;
  showDetailLink?: boolean;
  showHomepageLink?: boolean;
  instanceId: string;
  disclosureId?: string;
}): ReactElement {
  const deployment = node.modules.deployment;
  const governance = node.modules.governance;
  const rows = environmentRows(node);

  const finalizedCredits =
    governance.state === "available" &&
    governance.finalizedAttributionCredits.state === "available"
      ? governance.finalizedAttributionCredits.value
      : "Unavailable";
  const totalContributors =
    governance.state === "available" &&
    governance.totalContributors.state === "available"
      ? governance.totalContributors.value.toLocaleString()
      : "Unavailable";
  const epochsCompleted =
    governance.state === "available" &&
    governance.epochsCompleted.state === "available"
      ? governance.epochsCompleted.value.toLocaleString()
      : "Unavailable";
  const currentEpoch =
    governance.state === "available" &&
    governance.currentEpoch.state === "available"
      ? governance.currentEpoch.value
        ? `Epoch ${governance.currentEpoch.value.id} · ${governance.currentEpoch.value.status}`
        : "None open"
      : "Unavailable";

  return (
    <div id={disclosureId} className="space-y-5 bg-muted/20 p-4 md:p-5">
      <section
        aria-labelledby={`${instanceId}-deployments`}
        className="space-y-3"
      >
        <h3 id={`${instanceId}-deployments`} className="font-medium text-sm">
          Deployments
        </h3>
        {deployment.state === "available" ? (
          <DeploymentEnvironmentMatrix rows={rows} showCompute />
        ) : (
          <p className="text-muted-foreground text-sm">Unavailable</p>
        )}
      </section>

      <section
        aria-labelledby={`${instanceId}-governance`}
        className="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 id={`${instanceId}-governance`} className="font-medium text-sm">
            Governance
          </h3>
          <span className="text-muted-foreground text-xs">{currentEpoch}</span>
        </div>
        <dl className="grid gap-2 sm:grid-cols-3">
          <GovernanceMetric
            label="Finalized attribution credits"
            value={finalizedCredits}
          />
          <GovernanceMetric
            label="Total contributors"
            value={totalContributors}
          />
          <GovernanceMetric label="Epochs completed" value={epochsCompleted} />
        </dl>
        {governance.state === "available" && governance.daoUrl ? (
          <a
            href={governance.daoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 text-primary text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            View DAO
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        {showDetailLink && node.relationship === "owner" ? (
          <Link
            href={node.detailUrl}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Manage
          </Link>
        ) : null}
        {showDetailLink && node.relationship === "developer" ? (
          <Link
            href={node.detailUrl}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            View details
          </Link>
        ) : null}
        {showHomepageLink &&
        deployment.state === "available" &&
        hasServingProduction(node) &&
        deployment.homepageUrl ? (
          <a
            href={deployment.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-primary text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open node
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function DisclosureButton({
  node,
  disclosureId,
  expanded,
  onToggle,
}: {
  node: NodeOperationsOverview;
  disclosureId: string;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={disclosureId}
      aria-label={`${expanded ? "Hide" : "Show"} ${node.title} details`}
      onClick={onToggle}
      className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ChevronDown
        className={cn(
          "size-4 transition-transform motion-reduce:transition-none",
          expanded && "rotate-180"
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function MobileNodeCard({ node }: { node: NodeOperationsOverview }) {
  const [expanded, setExpanded] = useState(false);
  const disclosureId = `${node.id}-operations-mobile`;
  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-20 items-center gap-3 p-4">
        <NodeBrandMark node={node} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{node.title}</p>
          <StatusLabel node={node} />
          <p className="mt-1 truncate font-medium text-sm tabular-nums">
            {computeLabel(node)}
            {node.modules.compute.state === "available" ? (
              <span className="ml-1 font-normal text-muted-foreground text-xs">
                sponsored
              </span>
            ) : null}
          </p>
        </div>
        <DisclosureButton
          node={node}
          disclosureId={disclosureId}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      </div>
      {expanded ? (
        <NodeDetails
          node={node}
          instanceId={`${node.id}-mobile`}
          disclosureId={disclosureId}
        />
      ) : null}
    </Card>
  );
}

const columnHelper = createColumnHelper<NodeOperationsOverview>();

export function NodeOperationsTable({
  nodes,
}: {
  readonly nodes: readonly NodeOperationsOverview[];
}): ReactElement {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "node", desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const columns = useMemo(
    () => [
      columnHelper.accessor((node) => node.title, {
        id: "node",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Node" />
        ),
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <NodeBrandMark node={row.original} />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.title}</p>
              <p className="truncate text-muted-foreground text-xs">
                {row.original.slug}
              </p>
            </div>
          </div>
        ),
        meta: {
          headerTitle: "Node",
          expandedContent: (node) => (
            <NodeDetails
              node={node}
              instanceId={`${node.id}-desktop`}
              disclosureId={`${node.id}-operations-desktop`}
            />
          ),
        },
      }),
      columnHelper.accessor(nodeStatusKey, {
        id: "status",
        header: ({ column }) => (
          <DataGridColumnHeader
            column={column}
            title="Status"
            filter={
              <HeaderFilter column={column} formatLabel={formatStatusFilter} />
            }
          />
        ),
        cell: ({ row }) => <StatusLabel node={row.original} />,
        filterFn: "arrIncludesSome",
        meta: { headerTitle: "Status" },
      }),
      columnHelper.accessor(buildLabel, {
        id: "production",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Production" />
        ),
        cell: ({ getValue }) => (
          <span className="font-mono text-muted-foreground text-xs">
            {getValue()}
          </span>
        ),
        meta: { headerTitle: "Production" },
      }),
      columnHelper.accessor(computeLabel, {
        id: "compute",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Compute" />
        ),
        cell: ({ row, getValue }) => (
          <div>
            <p className="font-medium text-sm tabular-nums">{getValue()}</p>
            {row.original.modules.compute.state === "available" ? (
              <p className="text-muted-foreground text-xs">Sponsored</p>
            ) : null}
          </div>
        ),
        meta: { headerTitle: "Compute" },
      }),
      columnHelper.display({
        id: "details",
        header: () => <span className="sr-only">Details</span>,
        cell: ({ row }) => (
          <div className="text-right">
            <DisclosureButton
              node={row.original}
              disclosureId={`${row.original.id}-operations-desktop`}
              expanded={row.getIsExpanded()}
              onToggle={() => row.toggleExpanded()}
            />
          </div>
        ),
        size: 56,
        enableSorting: false,
        meta: { headerTitle: "Details" },
      }),
    ],
    []
  );

  const table = useReactTable({
    data: [...nodes],
    columns,
    state: { sorting, columnFilters, globalFilter, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _columnId, value: string) => {
      const query = value.trim().toLowerCase();
      return (
        row.original.title.toLowerCase().includes(query) ||
        row.original.slug.toLowerCase().includes(query)
      );
    },
  });

  if (nodes.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
          <div>
            <h2 className="font-semibold text-lg">No nodes yet</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Find a community project to follow.
            </p>
          </div>
          <Link
            href="/explore/nodes"
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Discover nodes
          </Link>
        </CardContent>
      </Card>
    );
  }

  const healthy = nodes.filter(
    (node) => nodeStatusKey(node) === "healthy"
  ).length;
  const sponsored = sumComputeAmounts(
    nodes.flatMap((node) =>
      node.modules.compute.state === "available"
        ? [node.modules.compute.transferred]
        : []
    )
  );
  const availableCompute = nodes.filter(
    (node) => node.modules.compute.state === "available"
  );
  const environmentLabel =
    availableCompute[0]?.modules.compute.state === "available"
      ? (
          {
            "candidate-a": "Test",
            preview: "Preview",
            production: "Production",
          } as const
        )[availableCompute[0].modules.compute.environment]
      : null;
  const computeSummary =
    availableCompute.length === 0
      ? "Compute unavailable"
      : availableCompute.length < nodes.length
        ? `${formatComputeAmountsDisplay(sponsored)} sponsored in ${environmentLabel} · partial`
        : `${formatComputeAmountsDisplay(sponsored)} sponsored in ${environmentLabel}`;
  const visibleRows = table.getRowModel().rows;

  return (
    <section aria-labelledby="your-nodes" className="space-y-4">
      <div>
        <h1 id="your-nodes" className="font-bold text-2xl tracking-tight">
          Your nodes
        </h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {nodes.length} {nodes.length === 1 ? "node" : "nodes"} · {healthy}{" "}
          healthy · {computeSummary}
        </p>
      </div>

      <label
        htmlFor="node-operations-search"
        className="relative block w-full sm:w-64"
      >
        <span className="sr-only">Search nodes</span>
        <Search
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="node-operations-search"
          className="h-9 pl-9"
          placeholder="Find a node"
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
        />
      </label>

      <div className="hidden md:block">
        <DataGrid
          table={table}
          recordCount={nodes.length}
          tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
          emptyMessage="No matching nodes."
        >
          <DataGridContainer>
            <DataGridTable />
          </DataGridContainer>
        </DataGrid>
      </div>

      <div className="space-y-3 md:hidden">
        {visibleRows.length > 0 ? (
          visibleRows.map((row) => (
            <MobileNodeCard key={row.original.id} node={row.original} />
          ))
        ) : (
          <p className="py-8 text-center text-muted-foreground text-sm">
            No matching nodes.
          </p>
        )}
      </div>
    </section>
  );
}

export function NodeOperationsDetail({
  node,
}: {
  readonly node: NodeOperationsOverview;
}): ReactElement {
  return (
    <section aria-labelledby="node-operations-title" className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <NodeBrandMark node={node} />
          <div>
            <h1
              id="node-operations-title"
              className="font-bold text-2xl tracking-tight"
            >
              {node.title}
            </h1>
            <StatusLabel node={node} />
          </div>
        </div>
        {node.modules.deployment.state === "available" &&
        hasServingProduction(node) &&
        node.modules.deployment.homepageUrl ? (
          <a
            href={node.modules.deployment.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open node
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 gap-4 border-b p-4 md:p-5">
          <div>
            <p className="text-muted-foreground text-xs">Production</p>
            <p className="mt-1 font-mono text-sm">{buildLabel(node)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Compute</p>
            <p className="mt-1 font-medium text-sm tabular-nums">
              {computeLabel(node)}
            </p>
          </div>
        </div>
        <NodeDetails
          node={node}
          showDetailLink={false}
          showHomepageLink={false}
          instanceId={`${node.id}-detail`}
        />
      </Card>
    </section>
  );
}
