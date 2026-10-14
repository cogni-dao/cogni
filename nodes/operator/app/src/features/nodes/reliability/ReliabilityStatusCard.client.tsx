// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Human surface for the same ReliabilityStatusV1 served to agents and Grafana. */

"use client";

import type {
  ReliabilityEnvironment,
  ReliabilityStatusV1,
} from "@cogni/node-contracts";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components";

const ENVIRONMENTS: readonly ReliabilityEnvironment[] = [
  "candidate-a",
  "preview",
  "production",
];

const STATE_STYLE = {
  healthy: { label: "Healthy", icon: CheckCircle2, className: "text-success" },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    className: "text-warning",
  },
  contained: {
    label: "Contained",
    icon: ShieldAlert,
    className: "text-destructive",
  },
  recovering: {
    label: "Recovering",
    icon: AlertTriangle,
    className: "text-warning",
  },
  unknown: {
    label: "Unknown",
    icon: ShieldAlert,
    className: "text-destructive",
  },
} as const;

export function ReliabilityStatusCard({
  nodeId,
}: {
  readonly nodeId: string;
}): ReactElement {
  const [environment, setEnvironment] =
    useState<ReliabilityEnvironment>("production");
  const [status, setStatus] = useState<ReliabilityStatusV1 | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setStatus(null);
    void fetch(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/observability/health?env=${environment}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`health read failed: ${response.status}`);
        return (await response.json()) as ReliabilityStatusV1;
      })
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [environment, nodeId]);

  const display = STATE_STYLE[status?.state ?? "unknown"];
  const StateIcon = display.icon;

  return (
    <Card>
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Reliability</CardTitle>
          <span
            className={`inline-flex items-center gap-1.5 font-medium text-sm ${display.className}`}
          >
            <StateIcon className="size-4" aria-hidden="true" />
            {loading ? "Checking" : display.label}
          </span>
        </div>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Reliability environment</legend>
          {ENVIRONMENTS.map((env) => (
            <Button
              key={env}
              type="button"
              size="sm"
              variant={environment === env ? "default" : "outline"}
              onClick={() => setEnvironment(env)}
            >
              {env}
            </Button>
          ))}
        </fieldset>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status ? (
          <p className="text-destructive text-sm">
            Required evidence is unavailable. Reliability fails closed.
          </p>
        ) : (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <Metric label="Database" value={status.databaseTier} />
              <Metric
                label="Budget"
                value={status.budgetProfile ?? "unknown"}
              />
              <Metric
                label="I/O pressure"
                value={percent(status.utilization.ioPressurePct)}
              />
              <Metric
                label="Evidence scope"
                value={status.utilization.evidenceScope}
              />
              <Metric
                label="DB attribution"
                value={databaseShare(status.utilization.databaseShare5m)}
              />
              <Metric
                label="Connections"
                value={percent(status.utilization.connectionPct)}
              />
              <Metric
                label="Memory free"
                value={percent(status.utilization.memoryHeadroomPct)}
              />
              <Metric
                label="Disk free"
                value={percent(status.utilization.diskHeadroomPct)}
              />
              <Metric
                label="Build"
                value={status.buildSha?.slice(0, 12) ?? "unknown"}
                mono
              />
              <Metric
                label="Regions"
                value={
                  status.regionalReadiness.length === 0
                    ? "unknown"
                    : status.regionalReadiness
                        .map(
                          (region) =>
                            `${region.region}:${region.healthy ? "ready" : "down"}`
                        )
                        .join(" · ")
                }
              />
            </dl>
            {status.incidentReason ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                {status.incidentReason}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`mt-1 truncate font-medium ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function percent(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(1)}%`;
}

function databaseShare(
  shares: ReliabilityStatusV1["utilization"]["databaseShare5m"]
): string {
  const values = Object.values(shares).filter(
    (value): value is number => value !== null
  );
  return values.length === 3
    ? `max ${Math.max(...values).toFixed(1)}%`
    : "unknown";
}
