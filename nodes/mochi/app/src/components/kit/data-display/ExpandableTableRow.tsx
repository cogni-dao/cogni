// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/ExpandableTableRow`
 * Purpose: Reusable expandable row for shadcn Table — click to reveal detail content.
 * Scope: Kit component. Wraps TableRow + TableCell with expand/collapse state. Does not perform data fetching or server-side logic.
 * Invariants: Supports nesting (expandedContent can contain another Table with ExpandableTableRows).
 * Side-effects: none
 * Links: src/components/vendor/shadcn/table.tsx
 * @public
 */

"use client";

import { TableCell, TableRow } from "@cogni/node-ui-kit/shadcn/table";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

interface ExpandableTableRowProps {
  readonly cells: readonly ReactNode[];
  /** Optional className per cell (same index as cells). */
  readonly cellClassNames?: readonly (string | undefined)[];
  /** Legacy: free-form content rendered in a single colSpan cell. */
  readonly expandedContent?: ReactNode;
  /** Preferred: pre-built TableRow elements rendered as siblings when expanded. */
  readonly expandedRows?: readonly ReactNode[];
  readonly colSpan: number;
  readonly defaultExpanded?: boolean;
  readonly className?: string;
}

export function ExpandableTableRow({
  cells,
  cellClassNames,
  expandedContent,
  expandedRows,
  colSpan,
  defaultExpanded = false,
  className,
}: ExpandableTableRowProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasRows = expandedRows != null && expandedRows.length > 0;
  const hasContent = hasRows || expandedContent != null;

  return (
    <>
      <TableRow
        className={cn(
          hasContent && "cursor-pointer select-none",
          expanded && "bg-muted/30",
          className
        )}
        onClick={hasContent ? () => setExpanded((p) => !p) : undefined}
      >
        <TableCell className="w-8 px-2">
          {hasContent ? (
            expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )
          ) : (
            <span className="inline-block w-4" />
          )}
        </TableCell>
        {cells.map((cell, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static column order
          <TableCell key={i} className={cellClassNames?.[i]}>
            {cell}
          </TableCell>
        ))}
      </TableRow>
      {expanded && hasRows && expandedRows}
      {expanded && !hasRows && expandedContent != null && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="p-0">
            <div className="border-muted border-t bg-muted/10 px-4 py-3">
              {expandedContent}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
