// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/loading`
 * Purpose: Per-route Suspense fallback for `/knowledge`. Streams instantly while
 *   the server `page.tsx` awaits its port reads, so a first-time visitor sees an
 *   honest skeleton — never the old false "0 entries on main" flash.
 * Scope: Server component, layout-preserving inside `(app)/layout.tsx`. Mirrors
 *   the `view.tsx` shell: outer `flex flex-col gap-4 p-5 md:p-6`, header, then
 *   the dominant DataGrid.
 * Side-effects: none
 * Links: ./view.tsx, ./page.tsx, src/components/kit/layout/TableSkeleton.tsx
 * @public
 */

import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";
import { TableSkeleton } from "@/components/kit/layout/TableSkeleton";

export default function KnowledgeLoading() {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-40" withSubtitle subtitleWidth="w-56" />
      <TableSkeleton rows={10} withToolbar withPagination />
    </div>
  );
}
