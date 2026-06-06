// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/EpochCountdown`
 * Purpose: Monospace countdown timer with progress bar for the current epoch.
 * Scope: Governance feature component. Client-side timer with 60s interval. Does not perform data fetching or server-side logic.
 * Invariants: Progress computed from epoch start/end window. Timer updates every minute.
 * Side-effects: time
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import { Clock, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Badge, Card, CardContent, Progress } from "@/components";
import { useCollectEpoch } from "@/features/governance/hooks/useCollectEpoch";
import type { EpochView } from "@/features/governance/types";

interface EpochCountdownProps {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: EpochView["status"];
  readonly contributorCount: number;
  readonly totalPoints: number;
}

function useCountdown(periodStart: string, periodEnd: string) {
  const [timeLeft, setTimeLeft] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const end = new Date(periodEnd).getTime();
    const start = new Date(periodStart).getTime();
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, end - now);
      const total = end - start;
      setProgress(Math.min(100, ((total - remaining) / total) * 100));
      const d = Math.floor(remaining / 86_400_000);
      const h = Math.floor((remaining % 86_400_000) / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      setTimeLeft(`${d}d  ${h}h  ${String(m).padStart(2, "0")}m`);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [periodStart, periodEnd]);

  return { timeLeft, progress };
}

function StatusBadge({
  status,
}: {
  status: EpochView["status"];
}): ReactElement {
  switch (status) {
    case "open":
      return (
        <Badge intent="default" size="sm" className="animate-pulse">
          ACTIVE
        </Badge>
      );
    case "review":
      return (
        <Badge intent="secondary" size="sm">
          IN REVIEW
        </Badge>
      );
    case "finalized":
      return (
        <Badge intent="secondary" size="sm">
          FINALIZED
        </Badge>
      );
  }
}

function CollectIcon(): ReactElement {
  const { loading, cooldownSeconds, trigger } = useCollectEpoch();

  return (
    <button
      type="button"
      onClick={() => void trigger()}
      disabled={loading || cooldownSeconds != null}
      className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      title="Refresh epoch data"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
    </button>
  );
}

export function EpochCountdown({
  periodStart,
  periodEnd,
  status,
  contributorCount,
  totalPoints,
}: EpochCountdownProps): ReactElement {
  const { timeLeft, progress } = useCountdown(periodStart, periodEnd);

  return (
    <Card className="border-border/50 bg-card/50">
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span className="text-sm">
              {status === "open" ? "Time remaining" : "Epoch ended"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            <CollectIcon />
          </div>
        </div>
        <div className="mb-2 font-bold font-mono text-2xl text-foreground">
          {timeLeft}
        </div>
        <Progress value={progress} className="h-1.5 bg-secondary" />
        <div className="mt-2 flex justify-between text-muted-foreground text-xs">
          <span>{contributorCount} contributors</span>
          <span>{totalPoints} total points</span>
        </div>
      </CardContent>
    </Card>
  );
}
