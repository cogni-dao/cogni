// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Client-side work dashboard. ReUI DataGrid with per-column header
 *          dropdowns owning sort + filter, single top-right Columns toggle,
 *          search input, URL-driven state, detail panel.
 * Scope: Presentation. Fetches data via React Query.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the column header dropdown (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search persist in URL params.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemDto`.
 * Side-effects: IO (fetches from /api/v1/work/items)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridPagination } from "@cogni/node-ui-kit/reui/data-grid/data-grid-pagination";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@/components";

import { fetchWorkItems } from "./_api/fetchWorkItems";
import { columns } from "./_components/columns";
import { WorkItemDetail } from "./_components/WorkItemDetail";

const ACTIVE_STATUSES = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "blocked",
];

export function WorkDashboardView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items"],
    queryFn: fetchWorkItems,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];

  const initialFilters = useMemo((): ColumnFiltersState => {
    const filters: ColumnFiltersState = [];
    const typeParam = searchParams.get("type");
    if (typeParam) filters.push({ id: "type", value: typeParam.split(",") });
    const statusParam = searchParams.get("status");
    if (statusParam) {
      filters.push({ id: "status", value: statusParam.split(",") });
    } else {
      filters.push({ id: "status", value: ACTIVE_STATUSES });
    }
    const projectParam = searchParams.get("project");
    if (projectParam)
      filters.push({ id: "projectId", value: projectParam.split(",") });
    return filters;
  }, [searchParams]);

  const initialSorting = useMemo((): SortingState => {
    const sortParam = searchParams.get("sort");
    if (sortParam) {
      const desc = sortParam.startsWith("-");
      const id = desc ? sortParam.slice(1) : sortParam;
      return [{ id, desc }];
    }
    return [{ id: "priority", desc: false }];
  }, [searchParams]);

  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] =
    useState<ColumnFiltersState>(initialFilters);
  const [globalFilter, setGlobalFilter] = useState(searchParams.get("q") ?? "");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const syncUrl = useCallback(
    (
      newFilters: ColumnFiltersState,
      newSorting: SortingState,
      newQuery: string
    ) => {
      const params = new URLSearchParams();
      for (const f of newFilters) {
        const key = f.id === "projectId" ? "project" : f.id;
        if (Array.isArray(f.value) && f.value.length > 0) {
          params.set(key, (f.value as string[]).join(","));
        }
      }
      if (newSorting.length > 0 && newSorting[0]) {
        const s = newSorting[0];
        params.set("sort", s.desc ? `-${s.id}` : s.id);
      }
      if (newQuery) params.set("q", newQuery);
      const qs = params.toString();
      router.replace(qs ? `/work?${qs}` : "/work", { scroll: false });
    },
    [router]
  );

  const [selectedItem, setSelectedItem] = useState<WorkItemDto | null>(null);

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      syncUrl(columnFilters, next, globalFilter);
    },
    onColumnFiltersChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(columnFilters) : updater;
      setColumnFilters(next);
      syncUrl(next, sorting, globalFilter);
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.id.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.labels.some((l: string) => l.toLowerCase().includes(q))
      );
    },
  });

  const rows = table.getRowModel().rows;

  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (rows.length === 0) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.min(prev + 1, rows.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
            const row = rows[focusedRowIndex];
            if (row) {
              e.preventDefault();
              setSelectedItem(row.original);
            }
          }
          break;
        case "/":
          e.preventDefault();
          document
            .querySelector<HTMLInputElement>("[data-search-input]")
            ?.focus();
          break;
        case "Escape":
          if (selectedItem) {
            setSelectedItem(null);
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [rows, focusedRowIndex, selectedItem]);

  const hasActiveFilters = columnFilters.length > 0;

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-search-input
          className="h-9 w-full sm:w-56"
          placeholder="Search id, title, labels... ( / )"
          value={globalFilter}
          onChange={(e) => {
            setGlobalFilter(e.target.value);
            syncUrl(columnFilters, sorting, e.target.value);
          }}
        />
        {hasActiveFilters && (
          <button
            type="button"
            className="text-muted-foreground text-xs underline hover:text-foreground"
            onClick={() => {
              setColumnFilters([]);
              syncUrl([], sorting, globalFilter);
            }}
          >
            Clear filters
          </button>
        )}
        <div className="ml-auto">
          <DataGridColumnVisibility
            table={table}
            trigger={
              <Button variant="outline" size="sm" className="h-9 gap-1.5">
                <Settings2 className="size-3.5" />
                Columns
              </Button>
            }
          />
        </div>
      </div>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      {!error && (
        <DataGrid
          table={table}
          recordCount={items.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={(row) => setSelectedItem(row)}
          tableLayout={{
            headerSticky: true,
            headerBackground: true,
            rowBorder: true,
            dense: true,
          }}
          tableClassNames={{
            bodyRow: "cursor-pointer",
          }}
          emptyMessage="No work items found."
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination sizes={[25, 50, 100]} />
        </DataGrid>
      )}

      <WorkItemDetail
        item={selectedItem}
        open={selectedItem !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedItem(null);
        }}
      />
    </div>
  );
}
