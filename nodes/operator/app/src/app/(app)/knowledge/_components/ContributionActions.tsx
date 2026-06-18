// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionActions`
 * Purpose: Shared merge / reject action block for open knowledge contributions.
 * Scope: Presentation + local reject-reason state only; mutations are owned by callers.
 * @internal
 */

"use client";

import type { ContributionRecord } from "@cogni/node-contracts";
import { GitMerge, X } from "lucide-react";
import { useState } from "react";

import { Button, Input } from "@/components";

interface ContributionActionsProps {
  readonly item: ContributionRecord;
  readonly busy: boolean;
  readonly rejectBusy: boolean;
  readonly onMerge: (item: ContributionRecord) => void;
  readonly onReject: (item: ContributionRecord, reason: string) => void;
}

const REASON_MAX = 512;

export function ContributionActions({
  item,
  busy,
  rejectBusy,
  onMerge,
  onReject,
}: ContributionActionsProps) {
  const [rejectReason, setRejectReason] = useState("");

  if (item.state !== "open") {
    return null;
  }

  const disabled = busy || rejectBusy;
  const trimmedReason = rejectReason.trim();

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`reject-reason-${item.contributionId}`}
          className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
        >
          Reject reason
        </label>
        <Input
          id={`reject-reason-${item.contributionId}`}
          className="h-8 text-sm"
          placeholder="Why is this contribution rejected?"
          maxLength={REASON_MAX}
          value={rejectReason}
          disabled={disabled}
          onChange={(e) => setRejectReason(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled || trimmedReason === ""}
          onClick={() => {
            onReject(item, trimmedReason);
            setRejectReason("");
          }}
        >
          <X className="size-3.5" />
          {rejectBusy ? "Rejecting..." : "Reject"}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5"
          disabled={disabled}
          onClick={() => onMerge(item)}
        >
          <GitMerge className="size-3.5" />
          {busy ? "Merging..." : "Merge to main"}
        </Button>
      </div>
    </div>
  );
}
