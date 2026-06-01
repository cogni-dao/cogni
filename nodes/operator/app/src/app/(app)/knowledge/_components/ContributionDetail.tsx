// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionDetail`
 * Purpose: Slide-over Sheet for a single contribution. Renders metadata + the
 *   dolt_diff fetched lazily on open + Merge / Reject actions for open
 *   contributions (Reject captures a required reason).
 * Scope: Local fetch for the diff (lazy); merge/close mutations handed up via callback.
 * Side-effects: IO (GET .../diff on open).
 * @internal
 */

"use client";

import type {
  ContributionDiffEntry,
  ContributionRecord,
} from "@cogni/node-contracts";
import { GitMerge, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components";
import { HtmlRenderer } from "./HtmlRenderer";
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
  const [diff, setDiff] = useState<ContributionDiffEntry[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    if (!open || !item) {
      setDiff(null);
      setDiffError(null);
      setRejectReason("");
      return;
    }
    let cancelled = false;
    fetch(
      `/api/v1/knowledge/contributions/${encodeURIComponent(item.contributionId)}/diff`,
      { credentials: "same-origin", cache: "no-store" }
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ entries: ContributionDiffEntry[] }>;
      })
      .then((j) => {
        if (!cancelled) setDiff(j.entries);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setDiffError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, item]);

  const hasHtmlEntry = (diff ?? []).some(
    (d) =>
      ((d.after ?? d.before) as { entryType?: string } | null)?.entryType ===
      "html"
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={
          hasHtmlEntry
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
              <span className="font-mono text-muted-foreground text-xs">
                {item.contributionId}
              </span>
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
                {diffError && (
                  <p className="text-destructive text-xs">{diffError}</p>
                )}
                {!diffError && !diff && (
                  <p className="text-muted-foreground text-xs">Loading diff…</p>
                )}
                {diff && diff.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    No row changes detected.
                  </p>
                )}
                {diff && diff.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {diff.map((d) => {
                      const row = (d.after ?? d.before) as {
                        id?: string;
                        title?: string;
                        content?: string;
                        entryType?: string;
                      } | null;
                      const isHtml = row?.entryType === "html";
                      return (
                        <div
                          key={d.rowId}
                          className="rounded-md border border-border/50 bg-muted/30 px-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <span
                              className={`inline-flex rounded-md px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider ${
                                d.changeType === "added"
                                  ? "bg-success/15 text-success"
                                  : d.changeType === "removed"
                                    ? "bg-destructive/15 text-destructive"
                                    : "bg-warning/15 text-warning"
                              }`}
                            >
                              {d.changeType}
                            </span>
                            <span className="font-mono text-muted-foreground">
                              {d.rowId}
                            </span>
                            {row?.entryType && (
                              <span className="font-mono text-muted-foreground/70 text-xs">
                                {row.entryType}
                              </span>
                            )}
                          </div>
                          {row?.title && (
                            <p className="mt-1 line-clamp-2 font-medium text-sm">
                              {String(row.title)}
                            </p>
                          )}
                          {isHtml && row?.content && (
                            <div className="mt-2">
                              <HtmlRenderer
                                html={row.content}
                                title={row.title ?? "preview"}
                              />
                            </div>
                          )}
                          {!isHtml && row?.content && (
                            <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 text-xs leading-snug">
                              {String(row.content)}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
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
