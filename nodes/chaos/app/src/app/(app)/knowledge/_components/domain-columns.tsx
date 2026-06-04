// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/domain-columns`
 * Purpose: TanStack column definitions for the domain registry DataGrid.
 * Scope: Pure column descriptors. Does not fetch, route, or own state.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER (mirror /work pattern).
 * @internal
 */

"use client";

import type { DomainRow } from "@cogni/node-contracts";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { createColumnHelper } from "@tanstack/react-table";

const col = createColumnHelper<DomainRow>();

export const domainColumns = [
  col.accessor("id", {
    header: ({ column }) => <DataGridColumnHeader column={column} title="ID" />,
    size: 180,
    cell: (info) => (
      <span className="font-mono text-foreground text-xs">
        {info.getValue()}
      </span>
    ),
    meta: { headerTitle: "ID" },
  }),

  col.accessor("name", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Name" />
    ),
    size: 180,
    cell: (info) => <span className="text-sm">{info.getValue()}</span>,
    meta: { headerTitle: "Name" },
  }),

  col.accessor("description", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Description" />
    ),
    minSize: 280,
    cell: (info) => {
      const v = info.getValue();
      if (!v)
        return (
          <span className="text-muted-foreground text-xs italic">none</span>
        );
      return (
        <span className="line-clamp-1 text-muted-foreground text-xs">{v}</span>
      );
    },
    meta: { headerTitle: "Description" },
  }),

  col.accessor("entryCount", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Entries" />
    ),
    size: 80,
    cell: (info) => {
      const v = info.getValue();
      const tone =
        v > 0 ? "bg-success/15 text-success" : "bg-muted text-muted-foreground";
      return (
        <span
          className={`inline-flex min-w-7 justify-center rounded-md px-1.5 py-0.5 font-mono text-xs ${tone}`}
        >
          {v}
        </span>
      );
    },
    meta: { headerTitle: "Entries" },
  }),

  col.accessor("createdAt", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Registered" />
    ),
    size: 120,
    cell: (info) => {
      const v = info.getValue();
      if (!v) return <span className="text-muted-foreground">&mdash;</span>;
      return (
        <span className="text-muted-foreground text-xs">{v.slice(0, 10)}</span>
      );
    },
    sortingFn: (a, b) =>
      (a.original.createdAt ?? "").localeCompare(b.original.createdAt ?? ""),
    meta: { headerTitle: "Registered" },
  }),
];
