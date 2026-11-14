// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/header-filter`
 * Purpose: Inline multi-select facet filter rendered inside a `DataGridColumnHeader` dropdown so per-column filtering, sort, and hide all live in one place.
 * Scope: Client component reading `column.getFacetedUniqueValues()`; assumes the table has `getFacetedRowModel + getFacetedUniqueValues` enabled and `filterFn: "arrIncludesSome"` on the column. Does not fetch data or own URL state.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER — facet UI lives inside the column header dropdown, never as a parallel toolbar chip.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/frontend-development, work/items/task.0432.work-items-table-poly-standard.md
 * @public
 */

"use client";

import type { Column } from "@tanstack/react-table";
import { Check } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "./util/cn";

interface HeaderFilterProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  /** Optional value → display-label mapping. */
  readonly formatLabel?: (value: string) => string;
}

export function HeaderFilter<TData, TValue>({
  column,
  formatLabel,
}: HeaderFilterProps<TData, TValue>): ReactElement {
  const facets = column.getFacetedUniqueValues();
  const selected = new Set((column.getFilterValue() as string[]) ?? []);
  const values = [...facets.keys()]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => a.localeCompare(b));

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    column.setFilterValue(next.size === 0 ? undefined : Array.from(next));
  }

  if (values.length === 0) {
    return <span className="text-muted-foreground text-xs">No values</span>;
  }

  return (
    <div className="flex max-h-64 min-w-56 flex-col gap-0.5 overflow-y-auto pr-1">
      {values.map((v) => {
        const isSelected = selected.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(v);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                isSelected ? "bg-primary text-primary-foreground" : "opacity-50"
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </span>
            <span className="flex-1 truncate capitalize">
              {formatLabel ? formatLabel(v) : v}
            </span>
            <span className="shrink-0 pl-2 font-mono text-muted-foreground text-xs tabular-nums">
              {facets.get(v)}
            </span>
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            column.setFilterValue(undefined);
          }}
          className="mt-1 rounded-sm px-2 py-1 text-center text-muted-foreground text-xs hover:bg-accent"
        >
          Clear
        </button>
      )}
    </div>
  );
}
