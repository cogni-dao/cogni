// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Client-side work dashboard composing the published work board
 *          capability (`@cogni/knowledge-base-ui`) and the ReUI DataGrid over
 *          one TanStack filter, sort, search and detail-navigation model.
 * Scope: Route composition. Fetches data via React Query and maps table state
 *        to URL params; board controls, columns and cards come from the package.
 * Invariants:
 *   - BOARD_FROM_PACKAGE — board mode renders only `WorkBoardToolbar` and
 *     `WorkBoardView` from `@cogni/knowledge-base-ui` (task.0044).
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in the
 *     package column headers and board filter bar.
 *   - SINGLE_COLUMNS_TOGGLE — table visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search / rank range / view / board
 *     columns persist in URL params (see `_lib/workItemNavigation.ts`).
 *   - TABLE_IS_DEFAULT — only `view=board` selects the board.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemDto`.
 * Side-effects: IO (fetches from /api/v1/work/items)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import {
  createWorkItemColumns,
  type WorkBoardGoalLink,
  WorkBoardToolbar,
  WorkBoardView,
  type WorkTableMeta,
  workItemGlobalFilterFn,
} from "@cogni/knowledge-base-ui";
import type { WorkItemDto } from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridPagination } from "@cogni/node-ui-kit/reui/data-grid/data-grid-pagination";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useIsMobile } from "@cogni/node-ui-kit/util/use-is-mobile";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  functionalUpdate,
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
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components";

import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  readBoardColumns,
  readWorkFilters,
  readWorkSorting,
  writeWorkListState,
} from "./_lib/workItemNavigation";

const columns = createWorkItemColumns<WorkItemDto>();

// bug.0006: phones show Item (title + id) and Status; the Columns toggle can
// still reveal the rest. Explicit user choices win over this default.
const MOBILE_HIDDEN_COLUMNS: VisibilityState = {
  priority: false,
  rankScore: false,
  type: false,
  projectId: false,
  updatedAt: false,
  estimate: false,
};

/** Renders a board goal pointer with this node's router link. */
function WorkGoalLink({ href, className, label }: WorkBoardGoalLink) {
  return (
    <Link href={href} prefetch={false} className={className}>
      {label}
    </Link>
  );
}

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items"],
    queryFn: fetchWorkItems,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const boardView = searchParams.get("view") === "board";
  const visibleStatuses = useMemo(
    () => readBoardColumns(searchParams),
    [searchParams]
  );

  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: () => fetchWorkItem(selectedItemId as string),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const [sorting, setSorting] = useState<SortingState>(() =>
    readWorkSorting(searchParams)
  );
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() =>
    readWorkFilters(searchParams)
  );
  const [globalFilter, setGlobalFilter] = useState(searchParams.get("q") ?? "");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const tableColumnVisibility = useMemo(
    () =>
      isMobile
        ? { ...MOBILE_HIDDEN_COLUMNS, ...columnVisibility }
        : columnVisibility,
    [isMobile, columnVisibility]
  );

  const replaceParams = useCallback(
    (params: URLSearchParams) => {
      const qs = params.toString();
      const basePath = selectedItemId
        ? `/work/items/${encodeURIComponent(selectedItemId)}`
        : "/work";
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    },
    [router, selectedItemId]
  );

  // Reads the live URL so edits made in one tick compose instead of overwriting.
  const syncUrl = useCallback(
    (
      newFilters: ColumnFiltersState,
      newSorting: SortingState,
      newQuery: string
    ) => {
      replaceParams(
        writeWorkListState(new URLSearchParams(window.location.search), {
          filters: newFilters,
          sorting: newSorting,
          query: newQuery,
        })
      );
    },
    [replaceParams]
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
      const params = new URLSearchParams(window.location.search);
      if (view === "board") params.set("view", "board");
      else params.delete("view");
      replaceParams(params);
    },
    [replaceParams]
  );

  const table = useReactTable({
    data: items,
    columns,
    meta: { isLoading } satisfies WorkTableMeta,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility: tableColumnVisibility,
    },
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, sorting);
      setSorting(next);
      syncUrl(columnFilters, next, globalFilter);
    },
    onColumnFiltersChange: (updater) => {
      const next = functionalUpdate(updater, columnFilters);
      setColumnFilters(next);
      syncUrl(next, sorting, globalFilter);
    },
    onGlobalFilterChange: (updater) => {
      const next = functionalUpdate(updater, globalFilter);
      setGlobalFilter(next);
      syncUrl(columnFilters, sorting, next);
    },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    // The board shows every filtered, sorted item; only the table paginates.
    manualPagination: boardView,
    globalFilterFn: workItemGlobalFilterFn,
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

  return (
    <div className="flex min-w-0 flex-col gap-4 p-5 md:p-6">
      <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <WorkBoardToolbar
        table={table}
        visibleStatuses={visibleStatuses}
        onVisibleStatusesChange={(updater) => {
          const params = new URLSearchParams(window.location.search);
          const next = functionalUpdate(updater, readBoardColumns(params));
          params.set("columns", next.join(","));
          replaceParams(params);
        }}
        showBoardColumns={boardView}
      >
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
      </WorkBoardToolbar>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      {!error && boardView && (
        <WorkBoardView
          table={table}
          visibleStatuses={visibleStatuses}
          isLoading={isLoading}
          onOpenItem={openItem}
          renderGoalLink={WorkGoalLink}
        />
      )}

      {!error && !boardView && (
        <DataGrid
          table={table}
          recordCount={table.getFilteredRowModel().rows.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={openItem}
          tableLayout={{
            // Auto layout on phones lets the visible columns share the viewport.
            width: isMobile ? "auto" : "fixed",
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
