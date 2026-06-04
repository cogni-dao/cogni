// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/HoldingCard`
 * Purpose: Table row for a single holder in the holdings view — rank, avatar, credits, ownership%.
 * Scope: Governance feature component. Renders as TableRow for use inside shadcn Table. Does not perform data fetching or server-side logic.
 * Invariants: BigInt credits displayed via Number() for presentation only.
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import type { ReactElement } from "react";

import { Badge, TableCell, TableRow } from "@/components";
import type { HoldingView } from "@/features/governance/types";

interface HoldingRowProps {
  readonly holding: HoldingView;
  readonly rank: number;
}

export function HoldingRow({ holding, rank }: HoldingRowProps): ReactElement {
  const credits = Number(holding.totalCredits);

  return (
    <TableRow>
      <TableCell className="w-10 text-center text-muted-foreground text-xs">
        {rank}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm">
            {holding.avatar}
          </div>
          <span className="font-medium text-sm">
            {holding.displayName ?? "Contributor"}
          </span>
          {!holding.isLinked && (
            <Badge intent="outline" size="sm" className="h-5 px-1.5">
              Unlinked
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {credits.toLocaleString()}
      </TableCell>
      <TableCell className="text-right font-medium text-sm">
        {holding.ownershipPercent}%
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-xs">
        {holding.epochsContributed}
      </TableCell>
    </TableRow>
  );
}
