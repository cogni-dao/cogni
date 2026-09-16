// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared provider-neutral Test / Preview / Production deployment matrix. */

import { AlertCircle, CheckCircle2, CircleDashed, Rocket } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { isObservedEnvironmentHealthy } from "@/features/nodes/operations/status";

export interface DeploymentEnvironmentRow {
  readonly env: string;
  readonly label: string;
  readonly declared: boolean;
  readonly health: "healthy" | "degraded" | "provisioning" | "unknown";
  readonly sourceSha: string | null;
  readonly buildSha: string | null;
  readonly compute?:
    | {
        readonly state: "available";
        readonly amount: string;
        readonly activeDeployments: number;
      }
    | { readonly state: "unavailable" };
  readonly action?: ReactNode;
}

const DISPLAY_STATUS = {
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
} as const;

export function environmentDisplayStatus(row: DeploymentEnvironmentRow) {
  if (!row.declared) return DISPLAY_STATUS.not_deployed;
  if (isObservedEnvironmentHealthy(row)) return DISPLAY_STATUS.healthy;
  if (row.health === "provisioning") return DISPLAY_STATUS.deploying;
  return DISPLAY_STATUS.needs_attention;
}

function EnvironmentStatus({ row }: { row: DeploymentEnvironmentRow }) {
  const status = environmentDisplayStatus(row);
  const Icon = status.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 ${status.className}`}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{status.label}</span>
    </span>
  );
}

export function DeploymentEnvironmentMatrix({
  rows,
  showCompute = false,
}: {
  readonly rows: readonly DeploymentEnvironmentRow[];
  readonly showCompute?: boolean;
}): ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">Not deployed</p>;
  }

  const showActions = rows.some((row) => row.action !== undefined);

  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-1/4 px-2">Environment</TableHead>
            <TableHead className="w-1/3 px-2">Status</TableHead>
            <TableHead className="w-1/6 px-2 text-right">Build</TableHead>
            {showCompute ? (
              <TableHead className="w-1/4 px-2 text-right">Sponsored</TableHead>
            ) : null}
            {showActions ? (
              <TableHead className="w-1/4 px-2 text-right">Action</TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.env}>
              <TableCell className="px-2 font-medium text-xs sm:text-sm">
                {row.label}
              </TableCell>
              <TableCell className="px-2 text-xs sm:text-sm">
                <EnvironmentStatus row={row} />
              </TableCell>
              <TableCell className="px-2 text-right font-mono text-muted-foreground text-xs">
                {row.buildSha?.slice(0, 7) ?? "—"}
              </TableCell>
              {showCompute ? (
                <TableCell className="px-2 text-right text-xs tabular-nums">
                  {row.compute?.state === "available" ? (
                    <span>
                      <span className="block font-medium">
                        {row.compute.amount}
                      </span>
                      <span className="block text-muted-foreground">
                        {row.compute.activeDeployments} active
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Unavailable</span>
                  )}
                </TableCell>
              ) : null}
              {showActions ? (
                <TableCell className="px-2 text-right">{row.action}</TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
