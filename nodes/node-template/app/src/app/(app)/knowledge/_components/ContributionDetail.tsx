// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionDetail`
 * Purpose: Slide-over Sheet for a single contribution. Renders metadata + the
 *   dolt_diff fetched lazily on open + a Merge action for open contributions.
 * Scope: Local fetch for the diff (lazy); merge mutation handed up via callback.
 * Side-effects: IO (GET .../diff on open).
 * @internal
 */

"use client";

import type {
  ContributionDiffEntry,
  ContributionRecord,
} from "@cogni/node-contracts";
import { GitMerge } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import {
  Button,
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
  readonly onOpenChange: (open: boolean) => void;
  readonly onMerge: (item: ContributionRecord) => void;
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
  onOpenChange,
  onMerge,
}: ContributionDetailProps): ReactElement {
  const [diff, setDiff] = useState<ContributionDiffEntry[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item) {
      setDiff(null);
      setDiffError(null);
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
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={busy}
                    onClick={() => onMerge(item)}
                  >
                    <GitMerge className="size-3.5" />
                    {busy ? "Merging…" : "Merge to main"}
                  </Button>
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
