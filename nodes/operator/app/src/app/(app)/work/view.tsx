// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Client-side work dashboard. ReUI DataGrid with per-column header
 *          dropdowns owning sort + filter, single top-right Columns toggle,
 *          search input, URL-driven state, detail panel. `?view=board` shows
 *          the same filtered, sorted items on the shared WorkBoard (task.0044).
 * Scope: Presentation. Fetches data via React Query.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the column header dropdown (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search / view persist in URL params.
 *   - TABLE_IS_DEFAULT — only `view=board` selects the board.
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
import { Columns3, List, Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@/components";

import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { columns } from "./_components/columns";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import { WorkKanban } from "./_components/WorkKanban";
import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  workListStateSearchParams,
} from "./_lib/workItemNavigation";

const ACTIVE_STATUSES = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "blocked",
];
const ALL_STATUSES = [...ACTIVE_STATUSES, "done", "cancelled"];

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items"],
    queryFn: fetchWorkItems,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const boardView = searchParams.get("view") === "board";

  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: () => fetchWorkItem(selectedItemId as string),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

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
      const params = workListStateSearchParams(searchParams);
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
      const basePath = selectedItemId
        ? `/work/items/${encodeURIComponent(selectedItemId)}`
        : "/work";
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    },
    [router, searchParams, selectedItemId]
  );

  const openItem = useCallback(
    (item: WorkItemDto) => {
      openWorkItemPermalink(router, item.id, searchParams);
    },
    [router, searchParams]
  );

  const closeItem = useCallback(() => {
    closeWorkItemPermalink(router, searchParams);
  }, [router, searchParams]);

  const setView = useCallback(
    (view: "board" | "table") => {
      const params = new URLSearchParams(searchParams.toString());
      if (view === "board") params.set("view", "board");
      else params.delete("view");
      const qs = params.toString();
      const basePath = selectedItemId
        ? `/work/items/${encodeURIComponent(selectedItemId)}`
        : "/work";
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    },
    [router, searchParams, selectedItemId]
  );

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
  // The board shows every filtered, sorted item; the table paginates them.
  const boardItems = table
    .getPrePaginationRowModel()
    .rows.map((row) => row.original);
  const statusFilter = columnFilters.find((f) => f.id === "status")?.value as
    | string[]
    | undefined;
  const boardStatuses = statusFilter?.length
    ? ALL_STATUSES.filter((status) => statusFilter.includes(status))
    : ALL_STATUSES;

  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (rows.length === 0) return;
      if (boardView && e.key !== "/" && e.key !== "Escape") return;

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
              openItem(row.original);
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
          if (selectedItemId) {
            closeItem();
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [rows, focusedRowIndex, selectedItemId, openItem, closeItem, boardView]);

  const hasActiveFilters = columnFilters.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-5 md:p-6">
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
        <div className="ml-auto flex items-center gap-2">
          <fieldset
            className="inline-flex min-w-0 rounded-lg border bg-muted/30 p-1"
            aria-label="Work view"
          >
            <Button
              variant={boardView ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={boardView}
              onClick={() => setView("board")}
            >
              <Columns3 className="size-3.5" />
              Board
            </Button>
            <Button
              variant={boardView ? "ghost" : "secondary"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={!boardView}
              onClick={() => setView("table")}
            >
              <List className="size-3.5" />
              Table
            </Button>
          </fieldset>
          {!boardView && (
            <DataGridColumnVisibility
              table={table}
              trigger={
                <Button variant="outline" size="sm" className="h-9 gap-1.5">
                  <Settings2 className="size-3.5" />
                  Columns
                </Button>
              }
            />
          )}
        </div>
      </div>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      {!error && boardView && (
        <WorkKanban
          items={boardItems}
          statuses={boardStatuses}
          isLoading={isLoading}
          onOpenItem={openItem}
        />
      )}

      {!error && !boardView && (
        <DataGrid
          table={table}
          recordCount={items.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={openItem}
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
        item={selectedItemQuery.data ?? null}
        {...(selectedItemId !== undefined && { itemId: selectedItemId })}
        isLoading={selectedItemQuery.isLoading}
        error={selectedItemQuery.error}
        open={selectedItemId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeItem();
        }}
      />
    </div>
  );
}
