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
import { type ReactElement, useState } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components";
import { ContributionActions } from "./ContributionActions";
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

export function ContributionDetail({
  item,
  open,
  busy,
  rejectBusy,
  onOpenChange,
  onMerge,
  onReject,
}: ContributionDetailProps): ReactElement {
  const [hasHtml, setHasHtml] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
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
              <ContributionActions
                item={item}
                busy={busy}
                rejectBusy={rejectBusy}
                onMerge={onMerge}
                onReject={onReject}
              />

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
