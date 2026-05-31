// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/NodeRow.client`
 * Purpose: Clickable node-list row that navigates to the node's setup page.
 * Scope: Client island. `position: relative` on a `<tr>` is unreliable for stretched
 *   links, so the whole row navigates via the router on click/Enter instead.
 * Links: task.5083
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import type { ReactElement } from "react";

import { Badge, TableCell, TableRow } from "@/components";

import { NODE_STATUS_DISPLAY } from "./node-display";

interface Props {
  readonly id: string;
  readonly slug: string;
  readonly status: keyof typeof NODE_STATUS_DISPLAY;
}

export function NodeRow({ id, slug, status }: Props): ReactElement {
  const router = useRouter();
  const display = NODE_STATUS_DISPLAY[status];
  const href = `/setup/nodes/${id}`;

  return (
    <TableRow
      role="link"
      tabIndex={0}
      className="cursor-pointer"
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(href);
        }
      }}
    >
      <TableCell className="font-medium">{slug}</TableCell>
      <TableCell className="text-right">
        <Badge intent={display.intent} size="sm">
          {display.label}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
