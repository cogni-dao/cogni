// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/columns`
 * Purpose: TanStack column definitions for the work-items DataGrid.
 * Scope: Pure column descriptors + inline cells. No fetching, no router.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: every header renders via reui
 *     `DataGridColumnHeader` so sort lives there. Discrete-value columns
 *     (type / status / projectId) inline a `HeaderFilter` so per-column
 *     multi-select filtering lives in the same dropdown.
 *   - Column visibility is NOT in the header dropdown — it lives in a single
 *     toolbar `Columns` button at top-right of `view.tsx`.
 *   - filterFn: "arrIncludesSome" on facet columns so HeaderFilter's
 *     setFilterValue(string[]) works.
 * @internal
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { HeaderFilter } from "@cogni/node-ui-kit/header-filter";

import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { createColumnHelper } from "@tanstack/react-table";
import { StatusPill, TypeIcon } from "./work-item-icons";

const col = createColumnHelper<WorkItemDto>();

const formatStatus = (v: string) =>
  v.replace("needs_", "").replaceAll("_", " ");

const formatProject = (v: string) => v.replace("proj.", "");

export const columns = [
  col.accessor("priority", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Pri" />
    ),
    size: 60,
    cell: (info) => {
      const v = info.getValue();
      if (v == null)
        return <span className="text-muted-foreground">&mdash;</span>;
      return (
        <span className="inline-flex w-7 justify-center rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
          P{v}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const pa = a.original.priority ?? 999;
      const pb = b.original.priority ?? 999;
      return pa - pb;
    },
    meta: { headerTitle: "Pri" },
  }),

  col.accessor("type", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Type"
        filter={<HeaderFilter column={column} />}
      />
    ),
    size: 55,
    cell: (info) => <TypeIcon type={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Type" },
  }),

  col.display({
    id: "item",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Item" />
    ),
    minSize: 250,
    cell: ({ row }) => {
      const { id, title } = row.original;
      return (
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="line-clamp-1 text-sm">{title}</span>
          <span className="font-mono text-muted-foreground text-xs">{id}</span>
        </div>
      );
    },
    meta: { headerTitle: "Item" },
  }),

  col.accessor("status", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Status"
        filter={<HeaderFilter column={column} formatLabel={formatStatus} />}
      />
    ),
    size: 150,
    cell: (info) => <StatusPill status={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Status" },
  }),

  col.accessor("projectId", {
    header: ({ column }) => (
      <DataGridColumnHeader
        column={column}
        title="Project"
        filter={<HeaderFilter column={column} formatLabel={formatProject} />}
      />
    ),
    size: 140,
    cell: (info) => {
      const v = info.getValue();
      if (!v) return null;
      return (
        <span className="truncate text-muted-foreground text-xs">
          {formatProject(v)}
        </span>
      );
    },
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Project" },
  }),

  col.accessor("updatedAt", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Updated" />
    ),
    size: 110,
    cell: (info) => {
      const v = info.getValue() || info.row.original.createdAt;
      if (!v) return <span className="text-muted-foreground">&mdash;</span>;
      return (
        <span className="text-muted-foreground text-xs">{v.slice(0, 10)}</span>
      );
    },
    sortingFn: (a, b) => {
      const da = a.original.updatedAt || a.original.createdAt || "";
      const db = b.original.updatedAt || b.original.createdAt || "";
      return da.localeCompare(db);
    },
    meta: { headerTitle: "Updated" },
  }),

  col.accessor("estimate", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Est" />
    ),
    size: 55,
    cell: (info) => {
      const v = info.getValue();
      return (
        <span className="text-center text-muted-foreground text-xs">
          {v ?? "—"}
        </span>
      );
    },
    meta: { headerTitle: "Est" },
  }),
];
