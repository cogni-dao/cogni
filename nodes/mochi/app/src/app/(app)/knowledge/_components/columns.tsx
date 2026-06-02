// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/columns`
 * Purpose: TanStack column definitions for the knowledge browse DataGrid.
 * Scope: Pure column descriptors. Does not fetch or route.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER (mirror /work pattern); per-column dropdown owns filter.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import { HeaderFilter } from "@cogni/node-ui-kit/header-filter";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { createColumnHelper } from "@tanstack/react-table";

import { ConfidenceBar } from "./ConfidenceBar";
import { CopyLinkButton } from "./CopyLinkButton";
import { RelativeTime } from "./RelativeTime";

const col = createColumnHelper<KnowledgeRow>();

export const knowledgeColumns = [
  col.accessor("domain", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Domain"
        filter={<HeaderFilter column={column} />}
      />
    ),
    size: 130,
    cell: (info) => (
      <span className="font-mono text-muted-foreground text-xs">
        {info.getValue()}
      </span>
    ),
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Domain" },
  }),

  col.display({
    id: "entry",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Entry" />
    ),
    minSize: 280,
    cell: ({ row }) => {
      const { id, title, entityId } = row.original;
      return (
        <div className="flex items-center gap-2 py-0.5">
          <CopyLinkButton path={`/knowledge/${id}`} label="Copy block link" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="line-clamp-1 text-sm">{title}</span>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-mono">{id}</span>
              {entityId && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono opacity-70">{entityId}</span>
                </>
              )}
            </div>
          </div>
        </div>
      );
    },
    meta: { headerTitle: "Entry" },
  }),

  col.accessor("entryType", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Type"
        filter={<HeaderFilter column={column} />}
      />
    ),
    size: 110,
    cell: (info) => (
      <span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
        {info.getValue()}
      </span>
    ),
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Type" },
  }),

  col.accessor("confidencePct", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Confidence" />
    ),
    size: 130,
    cell: (info) => <ConfidenceBar value={info.getValue() ?? null} />,
    sortingFn: (a, b) =>
      (a.original.confidencePct ?? -1) - (b.original.confidencePct ?? -1),
    meta: { headerTitle: "Confidence" },
  }),

  col.accessor("sourceType", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Source"
        filter={<HeaderFilter column={column} />}
      />
    ),
    size: 110,
    cell: (info) => {
      const v = info.getValue();
      return (
        <span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
          {v}
        </span>
      );
    },
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Source" },
  }),

  col.accessor("createdAt", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Created" />
    ),
    size: 110,
    cell: (info) => <RelativeTime iso={info.getValue()} />,
    sortingFn: (a, b) =>
      (a.original.createdAt ?? "").localeCompare(b.original.createdAt ?? ""),
    meta: { headerTitle: "Created" },
  }),
];
