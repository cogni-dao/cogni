// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/operations/NodeOperationsTable`
 * Purpose: Compact, responsive operations home for nodes visible to the current principal.
 * Scope: Presentation and disclosure state only. No infrastructure or billing semantics.
 * Invariants: TEXT_PLUS_COLOR, BUTTON_DISCLOSURE, PROVIDER_NEUTRAL, MOBILE_NO_OVERFLOW.
 * Side-effects: none
 * Links: /api/v1/dashboard/nodes, task.5112
 * @public
 */

"use client";

import type { NodeOperationsOverview } from "@cogni/node-contracts";
import { cn } from "@cogni/node-ui-kit/util/cn";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  Plus,
  Rocket,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { useState } from "react";

import {
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { formatComputeAmountsDisplay, sumComputeAmounts } from "./format-cost";

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
      <Icon className="size-4" aria-hidden="true" />
      {status.label}
    </span>
  );
}

function NodeMark({ node }: { node: NodeOperationsOverview }): ReactElement {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted font-semibold text-foreground uppercase">
      {node.title.charAt(0)}
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

function computeLabel(node: NodeOperationsOverview): string {
  const compute = node.modules.compute;
  if (compute.state === "unavailable") return "Unavailable";
  if (compute.activeDeployments === 0 && compute.transferred.length === 0) {
    return "No compute";
  }
  return formatComputeAmountsDisplay(compute.transferred);
}

function EnvironmentStatus({
  environment,
}: {
  environment: Extract<
    NodeOperationsOverview["modules"]["deployment"],
    { state: "available" }
  >["environments"][number];
}): ReactElement {
  const status = !environment.declared
    ? STATUS.not_deployed
    : environment.health === "healthy" &&
        environment.sourceSha !== null &&
        environment.sourceSha === environment.buildSha
      ? STATUS.healthy
      : environment.health === "provisioning"
        ? STATUS.deploying
        : STATUS.needs_attention;
  const Icon = status.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        status.className
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {status.label}
    </span>
  );
}

function NodeDetails({
  node,
  showManageLink = true,
  showHomepageLink = true,
  instanceId,
}: {
  node: NodeOperationsOverview;
  showManageLink?: boolean;
  showHomepageLink?: boolean;
  instanceId: string;
}): ReactElement {
  const deployment = node.modules.deployment;
  const compute = node.modules.compute;
  const governance = node.modules.governance;

  return (
    <div className="grid gap-4 p-4 md:grid-cols-3 md:p-5">
      <section
        aria-labelledby={`${instanceId}-deployments`}
        className="space-y-3"
      >
        <h3 id={`${instanceId}-deployments`} className="font-medium text-sm">
          Deployments
        </h3>
        {deployment.state === "available" &&
        deployment.environments.length > 0 ? (
          <div className="space-y-2">
            {deployment.environments.map((environment) => (
              <div
                key={environment.env}
                className="flex min-h-7 items-center justify-between gap-3"
              >
                <span className="text-muted-foreground text-sm">
                  {environment.label}
                </span>
                <span className="flex items-center gap-3">
                  <EnvironmentStatus environment={environment} />
                  <span className="w-14 text-right font-mono text-muted-foreground text-xs">
                    {environment.buildSha?.slice(0, 7) ?? "—"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : deployment.state === "available" ? (
          <p className="text-muted-foreground text-sm">Setup in progress</p>
        ) : (
          <p className="text-muted-foreground text-sm">Unavailable</p>
        )}
      </section>

      <section aria-labelledby={`${instanceId}-compute`} className="space-y-3">
        <h3 id={`${instanceId}-compute`} className="font-medium text-sm">
          Compute
        </h3>
        {compute.state === "available" ? (
          <div className="space-y-1">
            <p className="font-semibold text-lg tabular-nums">
              {compute.activeDeployments === 0 &&
              compute.transferred.length === 0
                ? "No active compute"
                : `${formatComputeAmountsDisplay(compute.transferred)} used`}
            </p>
            <p className="text-muted-foreground text-sm">Cogni-sponsored</p>
            <p className="text-muted-foreground text-xs">
              {compute.activeDeployments} active
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Unavailable</p>
        )}
      </section>

      <section
        aria-labelledby={`${instanceId}-governance`}
        className="space-y-3"
      >
        <h3 id={`${instanceId}-governance`} className="font-medium text-sm">
          Governance
        </h3>
        {governance.state === "available" ? (
          <div className="space-y-1 text-sm">
            <p>
              {governance.latestEpoch
                ? `Epoch ${governance.latestEpoch.id} · ${governance.latestEpoch.status}`
                : "No epochs yet"}
            </p>
            <p className="text-muted-foreground">
              {governance.finalizedEpochs} finalized
            </p>
            {governance.daoUrl ? (
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
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Unavailable</p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4 md:col-span-3">
        {showManageLink ? (
          <Link
            href={node.manageUrl}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Manage
          </Link>
        ) : null}
        {showHomepageLink &&
        deployment.state === "available" &&
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

function DesktopNodeRow({
  node,
}: {
  node: NodeOperationsOverview;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const disclosureId = `${node.id}-operations-desktop`;
  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-3">
            <NodeMark node={node} />
            <div className="min-w-0">
              <p className="truncate font-medium">{node.title}</p>
              {node.relationship === "developer" ? (
                <p className="text-muted-foreground text-xs">Developer</p>
              ) : null}
            </div>
          </div>
        </TableCell>
        <TableCell>
          <StatusLabel node={node} />
        </TableCell>
        <TableCell className="font-mono text-muted-foreground text-xs">
          {buildLabel(node)}
        </TableCell>
        <TableCell>
          <p className="font-medium text-sm tabular-nums">
            {computeLabel(node)}
          </p>
          {node.modules.compute.state === "available" ? (
            <p className="text-muted-foreground text-xs">Sponsored</p>
          ) : null}
        </TableCell>
        <TableCell className="w-14 text-right">
          <DisclosureButton
            node={node}
            disclosureId={disclosureId}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow id={disclosureId}>
          <TableCell colSpan={5} className="bg-muted/25 p-0">
            <NodeDetails node={node} instanceId={`${node.id}-desktop`} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function MobileNodeCard({
  node,
}: {
  node: NodeOperationsOverview;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const disclosureId = `${node.id}-operations-mobile`;
  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-20 items-center gap-3 p-4">
        <NodeMark node={node} />
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
        <div id={disclosureId} className="border-t bg-muted/20">
          <NodeDetails node={node} instanceId={`${node.id}-mobile`} />
        </div>
      ) : null}
    </Card>
  );
}

export function NodeOperationsTable({
  nodes,
}: {
  readonly nodes: readonly NodeOperationsOverview[];
}): ReactElement {
  if (nodes.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Plus className="size-6" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">No nodes yet</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Start a community project.
            </p>
          </div>
          <Link
            href="/nodes"
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Create node
          </Link>
        </CardContent>
      </Card>
    );
  }

  const healthy = nodes.filter(
    (node) =>
      node.modules.deployment.state === "available" &&
      node.modules.deployment.status === "healthy"
  ).length;
  const sponsored = sumComputeAmounts(
    nodes.flatMap((node) =>
      node.modules.compute.state === "available"
        ? [node.modules.compute.transferred]
        : []
    )
  );
  const availableComputeCount = nodes.filter(
    (node) => node.modules.compute.state === "available"
  ).length;
  const computeSummary =
    availableComputeCount === 0
      ? "Compute unavailable"
      : availableComputeCount < nodes.length
        ? `${formatComputeAmountsDisplay(sponsored)} sponsored · partial`
        : `${formatComputeAmountsDisplay(sponsored)} sponsored`;

  return (
    <section aria-labelledby="your-nodes" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 id="your-nodes" className="font-bold text-2xl tracking-tight">
            Your nodes
          </h1>
          <p className="mt-1 text-muted-foreground text-sm">
            {nodes.length} nodes · {healthy} healthy · {computeSummary}
          </p>
        </div>
        <Link
          href="/nodes"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Plus className="size-4" aria-hidden="true" />
          New node
        </Link>
      </div>

      <Card className="hidden overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Production</TableHead>
              <TableHead>Compute</TableHead>
              <TableHead>
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => (
              <DesktopNodeRow key={node.id} node={node} />
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="space-y-3 md:hidden">
        {nodes.map((node) => (
          <MobileNodeCard key={node.id} node={node} />
        ))}
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
          <NodeMark node={node} />
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
        <div
          className={cn(
            "grid grid-cols-2 gap-4 border-b p-4 md:p-5",
            node.relationship === "developer" && "sm:grid-cols-3"
          )}
        >
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
          {node.relationship === "developer" ? (
            <div className="col-span-2 sm:col-span-1">
              <p className="text-muted-foreground text-xs">Access</p>
              <p className="mt-1 text-sm">Developer</p>
            </div>
          ) : null}
        </div>
        <NodeDetails
          node={node}
          showManageLink={false}
          showHomepageLink={false}
          instanceId={`${node.id}-detail`}
        />
      </Card>
    </section>
  );
}
