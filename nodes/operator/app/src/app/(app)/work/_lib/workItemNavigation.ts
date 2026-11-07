// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_lib/workItemNavigation`
 * Purpose: Builds and applies route-backed work-item navigation and maps list state (filters, sort, search, rank range, board columns) to and from the URL.
 * Scope: Pure URL/history policy; no React or IO.
 * Invariants: Selection pushes for browser Back; close replaces to avoid a reopen loop. `status=all` means no status filter; an absent `status` means the active statuses.
 * Side-effects: router history mutation through the supplied interface
 * Links: bug.5355, ../view.tsx
 * @internal
 */

import {
  ACTIVE_WORK_STATUSES,
  DEFAULT_WORK_SORT,
  WORK_STATUSES,
} from "@cogni/knowledge-base-ui";
import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";

type SerializableSearchParams = Pick<URLSearchParams, "toString">;
type WorkRouter = {
  push(href: string, options: { scroll: boolean }): void;
  replace(href: string, options: { scroll: boolean }): void;
};

const WORK_LIST_CONTROLLED_PARAMS = [
  "type",
  "status",
  "project",
  "sort",
  "q",
  "rankMin",
  "rankMax",
] as const;

type RankRange = readonly [number | undefined, number | undefined];

function numberParam(
  searchParams: Pick<URLSearchParams, "get">,
  key: string
): number | undefined {
  const raw = searchParams.get(key);
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Reads table column filters from the URL; the default is every active status. */
export function readWorkFilters(
  searchParams: Pick<URLSearchParams, "get">
): ColumnFiltersState {
  const filters: ColumnFiltersState = [];
  const type = searchParams.get("type");
  if (type) filters.push({ id: "type", value: type.split(",") });
  const status = searchParams.get("status");
  if (status === null) {
    filters.push({ id: "status", value: [...ACTIVE_WORK_STATUSES] });
  } else if (status !== "all" && status !== "") {
    filters.push({ id: "status", value: status.split(",") });
  }
  const project = searchParams.get("project");
  if (project) filters.push({ id: "projectId", value: project.split(",") });
  const rank: RankRange = [
    numberParam(searchParams, "rankMin"),
    numberParam(searchParams, "rankMax"),
  ];
  if (rank[0] !== undefined || rank[1] !== undefined) {
    filters.push({ id: "rankScore", value: [...rank] });
  }
  return filters;
}

/** Reads the sort from the URL; the default is highest rank first. */
export function readWorkSorting(
  searchParams: Pick<URLSearchParams, "get">
): SortingState {
  const sort = searchParams.get("sort");
  if (sort) {
    const desc = sort.startsWith("-");
    return [{ id: desc ? sort.slice(1) : sort, desc }];
  }
  return DEFAULT_WORK_SORT.map((entry) => ({ ...entry }));
}

/** Board columns shown; the default is every active status. */
export function readBoardColumns(
  searchParams: Pick<URLSearchParams, "get">
): string[] {
  const value = searchParams.get("columns");
  return value === null
    ? [...ACTIVE_WORK_STATUSES]
    : value.split(",").filter((status) => WORK_STATUSES.includes(status));
}

/** Writes list state over `base`, keeping unrelated keys such as `view` and `columns`. */
export function writeWorkListState(
  base: SerializableSearchParams,
  state: {
    readonly filters: ColumnFiltersState;
    readonly sorting: SortingState;
    readonly query: string;
  }
): URLSearchParams {
  const params = workListStateSearchParams(base);
  const values = (id: string): string[] => {
    const value = state.filters.find((filter) => filter.id === id)?.value;
    return Array.isArray(value) ? (value as string[]) : [];
  };
  const type = values("type");
  if (type.length > 0) params.set("type", type.join(","));
  const status = values("status");
  params.set("status", status.length > 0 ? status.join(",") : "all");
  const project = values("projectId");
  if (project.length > 0) params.set("project", project.join(","));
  const rank = state.filters.find((filter) => filter.id === "rankScore")
    ?.value as RankRange | undefined;
  if (rank?.[0] !== undefined) params.set("rankMin", String(rank[0]));
  if (rank?.[1] !== undefined) params.set("rankMax", String(rank[1]));
  const sort = state.sorting[0];
  if (sort) params.set("sort", sort.desc ? `-${sort.id}` : sort.id);
  if (state.query) params.set("q", state.query);
  return params;
}

export function workListStateSearchParams(
  searchParams: SerializableSearchParams
): URLSearchParams {
  const next = new URLSearchParams(searchParams.toString());
  for (const key of WORK_LIST_CONTROLLED_PARAMS) next.delete(key);
  return next;
}

export function workListHref(searchParams: SerializableSearchParams): string {
  const query = searchParams.toString();
  return query ? `/work?${query}` : "/work";
}

export function workItemHref(
  id: string,
  searchParams: SerializableSearchParams
): string {
  const query = searchParams.toString();
  const path = `/work/items/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

export function openWorkItemPermalink(
  router: WorkRouter,
  id: string,
  searchParams: SerializableSearchParams
): void {
  router.push(workItemHref(id, searchParams), { scroll: false });
}

export function closeWorkItemPermalink(
  router: WorkRouter,
  searchParams: SerializableSearchParams
): void {
  router.replace(workListHref(searchParams), { scroll: false });
}
