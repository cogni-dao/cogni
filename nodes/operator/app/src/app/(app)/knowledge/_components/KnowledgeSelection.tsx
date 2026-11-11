// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeSelection`
 * Purpose: Open one knowledge entry by exact id in the side sheet. Exact-ID detail is
 *   independent of every loaded page; query identity prevents a stale selection.
 * Scope: One exact-id read through React Query plus the shared KnowledgeDetail sheet.
 * Side-effects: IO (GET /api/v1/knowledge/:id via fetchKnowledgeEntry)
 * @internal
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { fetchKnowledgeEntry } from "../_api/fetchKnowledgeEntry";
import { KnowledgeDetail } from "./KnowledgeDetail";

export function KnowledgeSelection({
  id,
  onClose,
}: {
  readonly id: string | null;
  readonly onClose: () => void;
}): ReactElement {
  const detail = useQuery({
    queryKey: ["knowledge", "detail", id],
    queryFn: ({ signal }) => fetchKnowledgeEntry(id ?? "", signal),
    enabled: id !== null,
    staleTime: 30_000,
    retry: false,
  });
  return (
    <KnowledgeDetail
      item={detail.data ?? null}
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      loading={detail.isFetching}
      error={detail.error}
      onRetry={() => void detail.refetch()}
    />
  );
}
