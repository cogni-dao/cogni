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
 *     `WorkBoardView` from `@cogni/knowledge-base-ui` (task.0044), fed by the
 *     package's `useWorkBoard` (task.0056).
 *   - BOUNDED_BOARD_READS — the page never downloads the backlog. Board mode
 *     makes one `/api/v1/work/board` request (≤20 summaries per visible status
 *     column) and one `/api/v1/work/summaries` request per column "Load more";
 *     table mode requests one cursor page through `useWorkTablePage`. No client
 *     code walks cursors (task.0056).
 *   - PACKAGE_QUERY_MAPPING — board and table requests are built by the package
 *     (`workBoardTableStateToQuery` + the shared codec): unsupported sort fields
 *     are dropped and `?pageSize=500` clamps to 100. Only URL navigation (cursor
 *     + an in-memory previous-page stack) stays here.
 *   - SERVER_FILTERS — filters, sort and search run on the server; the table
 *     only renders the page it received (manual sorting/filtering/pagination).
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in the
 *     package column headers and board filter bar.
 *   - SINGLE_COLUMNS_TOGGLE — table visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search / rank range / view / board
 *     columns persist in URL params (see `_lib/workItemNavigation.ts`).
 *   - TABLE_IS_DEFAULT — only `view=board` selects the board.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemSummary`.
 * Side-effects: IO (fetches the board, summary pages and full item detail)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import {
  clampWorkPageSize,
  createWorkItemColumns,
  useWorkBoard,
  useWorkTablePage,
  WORK_TABLE_PAGE_SIZES,
  type WorkBoardGoalLink,
  WorkBoardToolbar,
  WorkBoardView,
  type WorkTableMeta,
  workBoardTableStateToQuery,
  workItemGlobalFilterFn,
  workPageStackNext,
  workPageStackPrevious,
} from "@cogni/knowledge-base-ui";
import type { WorkItemSummary } from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useIsMobile } from "@cogni/node-ui-kit/util/use-is-mobile";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Columns3, List, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";

import {
  fetchWorkBoard,
  fetchWorkItem,
  fetchWorkItems,
} from "./_api/fetchWorkItems";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  readBoardColumns,
  readWorkFilters,
  readWorkSorting,
  writeWorkListState,
} from "./_lib/workItemNavigation";

const columns = createWorkItemColumns<WorkItemSummary>();

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

  const boardView = searchParams.get("view") === "board";
  const cursor = searchParams.get("cursor") ?? "";
  const visibleStatuses = useMemo(
    () => readBoardColumns(searchParams),
    [searchParams]
  );

  // PACKAGE_QUERY_MAPPING: board and table requests come from the package's
  // table-state mapping and codec, built from the committed URL state.
  const filterQuery = useMemo(
    () =>
      workBoardTableStateToQuery({
        sorting: readWorkSorting(searchParams),
        columnFilters: readWorkFilters(searchParams),
        globalFilter: searchParams.get("q") ?? "",
      }),
    [searchParams]
  );
  const tablePage = useWorkTablePage({
    query: filterQuery,
    pageSize: searchParams.get("pageSize"),
    cursor,
    fetchPage: fetchWorkItems,
    enabled: !boardView,
  });
  // Board reads share the table's filters and sort, never its page window.
  const board = useWorkBoard({
    query: filterQuery,
    statuses: boardView ? visibleStatuses : [],
    fetchBoard: fetchWorkBoard,
    fetchPage: fetchWorkItems,
  });
  const isLoading = boardView ? board.isLoading : tablePage.isLoading;
  const error = boardView ? board.error : tablePage.error;
  const items = (
    boardView ? board.items : tablePage.items
  ) as WorkItemSummary[];
  const tableEmptyMessage = tablePage.nextCursor
    ? "No matches on this page yet. Next continues the search."
    : "No work items found.";

  // Previous-page cursors for the current listing only (bounded by the package).
  const [pageStack, setPageStack] = useState<{
    readonly key: string;
    readonly stack: readonly string[];
  }>({ key: "", stack: [] });
  const history = pageStack.key === tablePage.listingKey ? pageStack.stack : [];

  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: ({ signal }) => fetchWorkItem(selectedItemId as string, signal),
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
      // A cursor is valid only for the listing that issued it.
      const base = new URLSearchParams(window.location.search);
      base.delete("cursor");
      replaceParams(
        writeWorkListState(base, {
          filters: newFilters,
          sorting: newSorting,
          query: newQuery,
        })
      );
    },
    [replaceParams]
  );

  const changePage = (action: "next" | "previous" | "restart") => {
    let next = "";
    let stack: string[] = [];
    if (action === "next") {
      // An empty capped page still carries a cursor: Next continues the search.
      if (!tablePage.nextCursor) return;
      next = tablePage.nextCursor;
      stack = workPageStackNext(history, cursor);
    } else if (action === "previous") {
      const previous = workPageStackPrevious(history);
      if (!cursor || !previous) return;
      next = previous.cursor;
      stack = previous.stack;
    } else if (!cursor) return;
    setPageStack({ key: tablePage.listingKey, stack });
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("cursor", next);
    else params.delete("cursor");
    replaceParams(params);
  };

  const openItem = useCallback(
    (item: WorkItemSummary) => {
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
      params.delete("cursor");
      replaceParams(params);
    },
    [replaceParams]
  );

  const table = useReactTable({
    getRowId: (item) => item.id,
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
    // SERVER_FILTERS: the server filtered, sorted and paged these rows.
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
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

      {error != null && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}
      {boardView && board.pageError != null && (
        <p className="text-destructive text-sm">Failed to load more items.</p>
      )}

      {error == null && boardView && (
        <WorkBoardView
          table={table}
          columns={board.columns}
          isLoading={isLoading}
          onOpenItem={openItem}
          onLoadMore={board.loadMore}
          renderGoalLink={WorkGoalLink}
        />
      )}

      {error == null && !boardView && (
        <DataGrid
          table={table}
          recordCount={items.length}
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
          emptyMessage={tableEmptyMessage}
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
        </DataGrid>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {boardView ? (
          <span>
            {items.length} cards loaded
            {board.columns.some((column) => column.hasMore)
              ? " · more in columns marked +"
              : ""}
          </span>
        ) : (
          <>
            <span>{items.length} items on this page</span>
            <div className="flex flex-wrap gap-2">
              <Select
                value={String(tablePage.pageSize)}
                onValueChange={(value) => {
                  const params = new URLSearchParams(window.location.search);
                  params.set("pageSize", String(clampWorkPageSize(value)));
                  params.delete("cursor");
                  replaceParams(params);
                }}
              >
                <SelectTrigger aria-label="Items per page" className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_TABLE_PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => changePage("restart")}
                disabled={!cursor}
              >
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => changePage("previous")}
                disabled={!cursor || history.length === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => changePage("next")}
                disabled={!tablePage.nextCursor}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>

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
