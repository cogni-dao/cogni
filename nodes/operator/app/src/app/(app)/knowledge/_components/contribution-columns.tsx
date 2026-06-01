// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/contribution-columns`
 * Purpose: TanStack column definitions for the contributions Inbox DataGrid.
 * Scope: Pure column descriptors. Action handlers receive callbacks via meta.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER; merge action lives in a per-row button.
 * @internal
 */

"use client";

import type { ContributionRecord } from "@cogni/node-contracts";
import { HeaderFilter } from "@cogni/node-ui-kit/header-filter";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { createColumnHelper } from "@tanstack/react-table";
import { GitMerge, X } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@/components";

import { CopyLinkButton } from "./CopyLinkButton";
import { RelativeTime } from "./RelativeTime";

const col = createColumnHelper<ContributionRecord>();

export interface ContributionColumnsDeps {
  onMerge: (row: ContributionRecord) => void;
  onReject: (row: ContributionRecord) => void;
  busyId: string | null;
}

export function buildContributionColumns(deps: ContributionColumnsDeps) {
  return [
    col.accessor("state", {
      header: ({ column }) => (
        <DataGridColumnHeader
          column={column}
          title="State"
          filter={<HeaderFilter column={column} />}
        />
      ),
      size: 100,
      cell: (info) => {
        const v = info.getValue();
        const tone =
          v === "open"
            ? "bg-warning/15 text-warning"
            : v === "merged"
              ? "bg-success/15 text-success"
              : "bg-muted text-muted-foreground";
        return (
          <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-medium text-xs ${tone}`}
          >
            {v}
          </span>
        );
      },
      filterFn: "arrIncludesSome",
      meta: { headerTitle: "State" },
    }),

    col.display({
      id: "contribution",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Contribution" />
      ),
      minSize: 280,
      cell: ({ row }) => {
        // Branch ref intentionally suppressed at the row level — it's storage
        // shape, not human-scan signal. Restore when a merkle/history viewer
        // makes commits + branches clickable (vNext). The branch + full slug
        // remain visible in ContributionDetail for audit.
        const { contributionId, message } = row.original;
        return (
          <div className="flex items-center gap-2 py-0.5">
            <CopyLinkButton
              path={`/knowledge/inbox/${contributionId}`}
              label="Copy contribution link"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="line-clamp-1 text-sm">{message}</span>
              <span className="line-clamp-1 font-mono text-muted-foreground text-xs">
                {contributionId}
              </span>
            </div>
          </div>
        );
      },
      meta: { headerTitle: "Contribution" },
    }),

    col.accessor("principalKind", {
      header: ({ column }) => (
        <DataGridColumnHeader
          column={column}
          title="Principal"
          filter={<HeaderFilter column={column} />}
        />
      ),
      size: 110,
      cell: (info) => {
        const kind = info.getValue();
        const id = info.row.original.principalId;
        return (
          <div className="flex flex-col gap-0.5 leading-tight">
            <span className="text-xs uppercase tracking-wider">{kind}</span>
            <span className="line-clamp-1 font-mono text-muted-foreground text-xs">
              {id}
            </span>
          </div>
        );
      },
      filterFn: "arrIncludesSome",
      meta: { headerTitle: "Principal" },
    }),

    col.accessor("commitCount", {
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Commits" />
      ),
      size: 60,
      cell: (info) => (
        <span className="inline-flex w-7 justify-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
          {info.getValue()}
        </span>
      ),
      meta: { headerTitle: "Commits" },
    }),

    col.accessor("createdAt", {
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Filed" />
      ),
      size: 110,
      cell: (info) => <RelativeTime iso={info.getValue()} />,
      sortingFn: (a, b) =>
        a.original.createdAt.localeCompare(b.original.createdAt),
      meta: { headerTitle: "Filed" },
    }),

    col.display({
      id: "action",
      header: () => null,
      size: 170,
      cell: ({ row }): ReactElement => {
        const r = row.original;
        const busy = deps.busyId === r.contributionId;
        const disabled = r.state !== "open" || busy;
        return (
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                deps.onMerge(r);
              }}
            >
              <GitMerge className="size-3" />
              {busy ? "Merging…" : "Merge"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-destructive text-xs hover:bg-destructive/10 hover:text-destructive"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                deps.onReject(r);
              }}
            >
              <X className="size-3" />
              Reject
            </Button>
          </div>
        );
      },
      meta: { headerTitle: "Action" },
    }),
  ];
}
