// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/ActivityTable`
 * Purpose: Presentational table component for displaying activity logs.
 * Scope: Renders list of usage logs. Does not handle pagination logic or business rules (display only).
 * Invariants:
 * - Presentational component (no business logic)
 * - Uses shadcn/table
 * Side-effects: none
 * Links: [ActivityView](../../../app/(app)/activity/view.tsx)
 * @public
 */

"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cogni/node-ui-kit/shadcn/table";

export interface ActivityLog {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  graphId: string;
  tokensIn: number;
  tokensOut: number;
  cost: string;
  speed: number;
  finish?: string | undefined;
}

export interface ActivityTableProps {
  logs: ActivityLog[];
}

export function ActivityTable({ logs }: ActivityTableProps) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Graph</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Tokens In</TableHead>
            <TableHead className="text-right">Tokens Out</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center">
                No activity found.
              </TableCell>
            </TableRow>
          ) : (
            logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell>
                  {new Date(log.timestamp).toLocaleString()}
                </TableCell>
                <TableCell>{log.graphId}</TableCell>
                <TableCell>{log.model}</TableCell>
                <TableCell className="text-right">{log.tokensIn}</TableCell>
                <TableCell className="text-right">{log.tokensOut}</TableCell>
                <TableCell className="text-right">
                  {log.cost === "—"
                    ? "—"
                    : `$${Number.parseFloat(log.cost).toFixed(6)}`}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
