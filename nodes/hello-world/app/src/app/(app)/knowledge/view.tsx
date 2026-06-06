// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/view`
 * Purpose: Client knowledge dashboard. Single ReUI DataGrid that switches between
 *   Browse mode (knowledge entries on `main`) and Inbox mode (open external-agent
 *   contributions). One segmented toggle, URL-driven filters/sort/mode.
 * Scope: Presentation. Fetches data via React Query; mutates via direct fetch.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER (column dropdowns).
 *   - SINGLE_COLUMNS_TOGGLE (toolbar, not per-column).
 *   - URL_DRIVEN_STATE (mode + filters persist in URL).
 *   - Cookie-session merges only — no Bearer header is ever sent from this page.
 * Side-effects: IO (GET /knowledge, GET /knowledge/contributions, POST .../merge, POST .../close).
 * Links: docs/spec/knowledge-syntropy.md, [/work view](../work/view.tsx)
 * @public
 */

"use client";

import type {
  ContributionRecord,
  DomainRow,
  KnowledgeRow,
} from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridPagination } from "@cogni/node-ui-kit/reui/data-grid/data-grid-pagination";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  GitBranch,
  GitMerge,
  Library,
  Plus,
  Settings2,
  Tags,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { Button, Input } from "@/components";

import { closeContribution } from "./_api/closeContribution";
import { fetchContributions } from "./_api/fetchContributions";
import { fetchDomains } from "./_api/fetchDomains";
import { fetchKnowledge } from "./_api/fetchKnowledge";
import { mergeContribution } from "./_api/mergeContribution";
import { AddDomainSheet } from "./_components/AddDomainSheet";
import { ContributionDetail } from "./_components/ContributionDetail";
import { knowledgeColumns } from "./_components/columns";
import { buildContributionColumns } from "./_components/contribution-columns";
import { domainColumns } from "./_components/domain-columns";
import { KnowledgeDetail } from "./_components/KnowledgeDetail";

type ViewMode = "browse" | "domains" | "inbox" | "chains";

const EDO_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "hypothesis",
  "decision",
  "outcome",
  "event",
]);

function isMode(v: string | null): v is ViewMode {
  return v === "browse" || v === "domains" || v === "inbox" || v === "chains";
}

export function KnowledgeDashboardView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const initialMode: ViewMode = isMode(searchParams.get("mode"))
    ? (searchParams.get("mode") as ViewMode)
    : "browse";
  const [mode, setMode] = useState<ViewMode>(initialMode);

  const setModeUrl = useCallback(
    (next: ViewMode) => {
      setMode(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "browse") params.delete("mode");
      else params.set("mode", next);
      const qs = params.toString();
      router.replace(qs ? `/knowledge?${qs}` : "/knowledge", { scroll: false });
    },
    [router, searchParams]
  );

  const knowledgeQuery = useQuery({
    queryKey: ["knowledge", "list"],
    queryFn: fetchKnowledge,
    staleTime: 30_000,
  });

  const domainsQuery = useQuery({
    queryKey: ["knowledge", "domains"],
    queryFn: fetchDomains,
    staleTime: 30_000,
  });

  const contributionsQuery = useQuery({
    queryKey: ["knowledge", "contributions", "open"],
    queryFn: () => fetchContributions("open"),
    staleTime: 15_000,
  });

  const openCount = contributionsQuery.data?.contributions.length ?? 0;

  const mergeMutation = useMutation({
    mutationFn: (id: string) => mergeContribution(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      closeContribution(vars.id, vars.reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const [addDomainOpen, setAddDomainOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
            Knowledge
          </h1>
          <span className="text-muted-foreground text-xs">
            What this node has learned ·{" "}
            {knowledgeQuery.data?.items.length ?? 0} entries on{" "}
            <code className="font-mono">main</code>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {mode === "domains" && (
            <Button
              type="button"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setAddDomainOpen(true)}
            >
              <Plus className="size-3.5" />
              Add domain
            </Button>
          )}
          <div className="inline-flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5">
            <ModeButton
              active={mode === "browse"}
              onClick={() => setModeUrl("browse")}
              label="Browse"
              icon={<Library className="size-3.5" />}
            />
            <ModeButton
              active={mode === "chains"}
              onClick={() => setModeUrl("chains")}
              label="Chains"
              icon={<GitBranch className="size-3.5" />}
            />
            <ModeButton
              active={mode === "domains"}
              onClick={() => setModeUrl("domains")}
              label="Domains"
              icon={<Tags className="size-3.5" />}
            />
            <ModeButton
              active={mode === "inbox"}
              onClick={() => setModeUrl("inbox")}
              label="Inbox"
              icon={<GitMerge className="size-3.5" />}
              {...(openCount > 0 ? { badge: openCount } : {})}
            />
          </div>
        </div>
      </div>

      {mode === "browse" && (
        <BrowsePanel
          rows={knowledgeQuery.data?.items ?? []}
          isLoading={knowledgeQuery.isLoading}
          error={knowledgeQuery.error}
          mode="browse"
        />
      )}
      {mode === "chains" && (
        <BrowsePanel
          rows={(knowledgeQuery.data?.items ?? []).filter((r) =>
            EDO_ENTRY_TYPES.has(r.entryType)
          )}
          isLoading={knowledgeQuery.isLoading}
          error={knowledgeQuery.error}
          mode="chains"
        />
      )}
      {mode === "domains" && (
        <DomainsPanel
          rows={domainsQuery.data?.domains ?? []}
          isLoading={domainsQuery.isLoading}
          error={domainsQuery.error}
          onAddDomain={() => setAddDomainOpen(true)}
        />
      )}
      {mode === "inbox" && (
        <InboxPanel
          rows={contributionsQuery.data?.contributions ?? []}
          isLoading={contributionsQuery.isLoading}
          error={contributionsQuery.error}
          busyId={
            mergeMutation.isPending ? (mergeMutation.variables ?? null) : null
          }
          rejectBusyId={
            closeMutation.isPending
              ? (closeMutation.variables?.id ?? null)
              : null
          }
          onMerge={(r) => mergeMutation.mutate(r.contributionId)}
          onReject={(id, reason) => closeMutation.mutate({ id, reason })}
        />
      )}

      <AddDomainSheet
        open={addDomainOpen}
        onOpenChange={setAddDomainOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["knowledge", "domains"] });
        }}
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  icon,
  badge,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors ${
        active
          ? "bg-background font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
      {badge != null && (
        <span className="ml-0.5 inline-flex min-w-5 justify-center rounded-md bg-warning/20 px-1 font-mono text-warning text-xs">
          {badge}
        </span>
      )}
    </button>
  );
}

function BrowsePanel({
  rows,
  isLoading,
  error,
  mode,
}: {
  readonly rows: KnowledgeRow[];
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly mode: "browse" | "chains";
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [selected, setSelected] = useState<KnowledgeRow | null>(null);

  const table = useReactTable({
    data: rows,
    columns: knowledgeColumns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.id.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q) ||
        d.domain.toLowerCase().includes(q) ||
        d.entryType.toLowerCase().includes(q) ||
        (d.entityId?.toLowerCase().includes(q) ?? false)
      );
    },
  });

  return (
    <>
      <Toolbar
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        hasActiveFilters={columnFilters.length > 0}
        onClearFilters={() => setColumnFilters([])}
        table={table}
        searchPlaceholder="Search id, title, content, domain, type…"
      />
      {error ? (
        <p className="py-8 text-center text-destructive">
          Failed to load knowledge.
        </p>
      ) : rows.length === 0 && !isLoading ? (
        mode === "chains" ? (
          <ChainsEmptyState />
        ) : (
          <BrowseEmptyState />
        )
      ) : (
        <DataGrid
          table={table}
          recordCount={rows.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={(row) => setSelected(row)}
          tableLayout={{
            headerSticky: true,
            headerBackground: true,
            rowBorder: true,
            dense: true,
          }}
          tableClassNames={{ bodyRow: "cursor-pointer" }}
          emptyMessage="No knowledge entries match these filters."
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination sizes={[25, 50, 100]} />
        </DataGrid>
      )}
      <KnowledgeDetail
        item={selected}
        open={selected !== null}
        showChain={mode === "chains"}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </>
  );
}

function ChainsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
      <GitBranch className="size-8 text-muted-foreground/60" />
      <p className="font-medium text-sm">No EDO entries yet.</p>
      <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
        Chains view shows hypothesis / decision / outcome / event entries — the
        causal scaffolding of the hypothesis loop. Land an EDO entry through{" "}
        <code className="font-mono">/api/v1/edo/hypothesize</code> (or the agent
        tool <code className="font-mono">core__edo_hypothesize</code>) and a
        card will appear here.
      </p>
    </div>
  );
}

function InboxPanel({
  rows,
  isLoading,
  error,
  busyId,
  rejectBusyId,
  onMerge,
  onReject,
}: {
  readonly rows: ContributionRecord[];
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly busyId: string | null;
  readonly rejectBusyId: string | null;
  readonly onMerge: (row: ContributionRecord) => void;
  readonly onReject: (id: string, reason: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [selected, setSelected] = useState<ContributionRecord | null>(null);

  const columns = useMemo(
    () =>
      buildContributionColumns({
        onMerge,
        onReject: (r) => setSelected(r),
        busyId,
      }),
    [onMerge, busyId]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.contributionId.toLowerCase().includes(q) ||
        d.message.toLowerCase().includes(q) ||
        d.principalId.toLowerCase().includes(q) ||
        d.branch.toLowerCase().includes(q)
      );
    },
  });

  return (
    <>
      <Toolbar
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        hasActiveFilters={columnFilters.length > 0}
        onClearFilters={() => setColumnFilters([])}
        table={table}
        searchPlaceholder="Search contributionId, message, principal…"
      />
      {error ? (
        <p className="py-8 text-center text-destructive">
          Failed to load contributions.
        </p>
      ) : rows.length === 0 && !isLoading ? (
        <InboxEmptyState />
      ) : (
        <DataGrid
          table={table}
          recordCount={rows.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={(row) => setSelected(row)}
          tableLayout={{
            headerSticky: true,
            headerBackground: true,
            rowBorder: true,
            dense: true,
          }}
          tableClassNames={{ bodyRow: "cursor-pointer" }}
          emptyMessage="No contributions match these filters."
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination sizes={[25, 50, 100]} />
        </DataGrid>
      )}
      <ContributionDetail
        item={selected}
        open={selected !== null}
        busy={busyId !== null && selected?.contributionId === busyId}
        rejectBusy={
          rejectBusyId !== null && selected?.contributionId === rejectBusyId
        }
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
        onMerge={(r) => {
          onMerge(r);
          setSelected(null);
        }}
        onReject={(r, reason) => {
          onReject(r.contributionId, reason);
          setSelected(null);
        }}
      />
    </>
  );
}

function Toolbar({
  globalFilter,
  onGlobalFilterChange,
  hasActiveFilters,
  onClearFilters,
  table,
  searchPlaceholder,
}: {
  readonly globalFilter: string;
  readonly onGlobalFilterChange: (v: string) => void;
  readonly hasActiveFilters: boolean;
  readonly onClearFilters: () => void;
  // biome-ignore lint/suspicious/noExplicitAny: react-table generic boundary
  readonly table: any;
  readonly searchPlaceholder: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="h-9 w-full sm:w-72"
        placeholder={searchPlaceholder}
        value={globalFilter}
        onChange={(e) => onGlobalFilterChange(e.target.value)}
      />
      {hasActiveFilters && (
        <button
          type="button"
          className="text-muted-foreground text-xs underline hover:text-foreground"
          onClick={onClearFilters}
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
  );
}

function BrowseEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
      <Library className="size-8 text-muted-foreground/60" />
      <p className="font-medium text-sm">
        No knowledge yet on <code className="font-mono">main</code>.
      </p>
      <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
        Knowledge accumulates two ways: agents writing through{" "}
        <code className="font-mono">core__knowledge_write</code> during runs,
        and external contributors landing branches that you merge from the
        Inbox. Both paths are live — the table fills as soon as either fires.
      </p>
    </div>
  );
}

function InboxEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
      <GitMerge className="size-8 text-muted-foreground/60" />
      <p className="font-medium text-sm">Inbox empty.</p>
      <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
        No external-agent contributions are waiting. Agents POST to{" "}
        <code className="font-mono">/api/v1/knowledge/contributions</code> with
        a Bearer token; the contributions land here for any signed-in user to
        review and merge.
      </p>
    </div>
  );
}

function DomainsPanel({
  rows,
  isLoading,
  error,
  onAddDomain,
}: {
  readonly rows: DomainRow[];
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly onAddDomain: () => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "id", desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data: rows,
    columns: domainColumns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.id.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        (d.description?.toLowerCase().includes(q) ?? false)
      );
    },
  });

  return (
    <>
      <Toolbar
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        hasActiveFilters={columnFilters.length > 0}
        onClearFilters={() => setColumnFilters([])}
        table={table}
        searchPlaceholder="Search id, name, description…"
      />
      {error ? (
        <p className="py-8 text-center text-destructive">
          Failed to load domains.
        </p>
      ) : rows.length === 0 && !isLoading ? (
        <DomainsEmptyState onAddDomain={onAddDomain} />
      ) : (
        <DataGrid
          table={table}
          recordCount={rows.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          tableLayout={{
            headerSticky: true,
            headerBackground: true,
            rowBorder: true,
            dense: true,
          }}
          emptyMessage="No domains match these filters."
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination sizes={[25, 50, 100]} />
        </DataGrid>
      )}
    </>
  );
}

function DomainsEmptyState({
  onAddDomain,
}: {
  readonly onAddDomain: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
      <Tags className="size-8 text-muted-foreground/60" />
      <p className="font-medium text-sm">No domains registered.</p>
      <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
        Operator base domains (<code className="font-mono">meta</code>,{" "}
        <code className="font-mono">nodes</code>,{" "}
        <code className="font-mono">infrastructure</code>,{" "}
        <code className="font-mono">governance</code>) ship in the migrator — if
        you see this screen, it hasn't run. Otherwise register an extension
        domain.
      </p>
      <Button
        type="button"
        size="sm"
        className="mt-2 h-9 gap-1.5"
        onClick={onAddDomain}
      >
        <Plus className="size-3.5" />
        Add domain
      </Button>
    </div>
  );
}
