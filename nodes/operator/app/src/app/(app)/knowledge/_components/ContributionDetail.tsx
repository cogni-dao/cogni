// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionDetail`
 * Purpose: Slide-over Sheet for a single contribution. Renders metadata + the
 *   dolt_diff (via shared `ContributionDiff`) + Merge / Reject actions for open
 *   contributions (Reject captures a required reason) + a copy-link to the
 *   contribution permalink.
 * Scope: merge/close mutations handed up via callback.
 * @internal
 */

"use client";

import type { ContributionRecord } from "@cogni/node-contracts";
import { GitMerge, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components";
import { ContributionDiff, diffHasHtmlEntry } from "./ContributionDiff";
import { CopyLinkButton } from "./CopyLinkButton";
import { RelativeTime } from "./RelativeTime";

interface ContributionDetailProps {
  readonly item: ContributionRecord | null;
  readonly open: boolean;
  readonly busy: boolean;
  readonly rejectBusy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMerge: (item: ContributionRecord) => void;
  readonly onReject: (item: ContributionRecord, reason: string) => void;
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): ReactElement | null {
  if (!children) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

const REASON_MAX = 512;

export function ContributionDetail({
  item,
  open,
  busy,
  rejectBusy,
  onOpenChange,
  onMerge,
  onReject,
}: ContributionDetailProps): ReactElement {
  const [rejectReason, setRejectReason] = useState("");
  const [hasHtml, setHasHtml] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setRejectReason("");
          setHasHtml(false);
        }
        onOpenChange(o);
      }}
    >
      <SheetContent
        className={
          hasHtml
            ? "w-full overflow-y-auto sm:max-w-4xl"
            : "w-full overflow-y-auto sm:max-w-lg"
        }
      >
        {item && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <span
                  className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-medium uppercase tracking-wider"
                  title={item.principalId}
                >
                  {item.principalKind}
                </span>
                <span aria-hidden="true">·</span>
                <RelativeTime iso={item.createdAt} />
                <span aria-hidden="true">·</span>
                <span
                  className="font-mono"
                  title={`${item.commitCount} commits @ ${(item.headCommit ?? item.baseCommit).slice(0, 7)}`}
                >
                  {item.commitCount} commit{item.commitCount === 1 ? "" : "s"}
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug">
                {item.message}
              </SheetTitle>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground text-xs">
                  {item.contributionId}
                </span>
                <CopyLinkButton
                  path={`/knowledge/inbox/${item.contributionId}`}
                  label="Copy contribution link"
                />
              </div>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-5 px-1">
              {item.state === "open" && (
                <div className="flex flex-col gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="reject-reason"
                      className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
                    >
                      Reject reason
                    </label>
                    <Input
                      id="reject-reason"
                      className="h-8 text-sm"
                      placeholder="Why is this contribution rejected?"
                      maxLength={REASON_MAX}
                      value={rejectReason}
                      disabled={busy || rejectBusy}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={
                        busy || rejectBusy || rejectReason.trim() === ""
                      }
                      onClick={() => onReject(item, rejectReason.trim())}
                    >
                      <X className="size-3.5" />
                      {rejectBusy ? "Rejecting…" : "Reject"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 gap-1.5"
                      disabled={busy || rejectBusy}
                      onClick={() => onMerge(item)}
                    >
                      <GitMerge className="size-3.5" />
                      {busy ? "Merging…" : "Merge to main"}
                    </Button>
                  </div>
                </div>
              )}

              <Field label="Entries">
                <ContributionDiff
                  contributionId={item.contributionId}
                  onLoaded={(diff) => setHasHtml(diffHasHtmlEntry(diff))}
                />
              </Field>

              {item.idempotencyKey && (
                <Field label="Idempotency">
                  <span className="font-mono text-muted-foreground text-xs">
                    {item.idempotencyKey}
                  </span>
                </Field>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
