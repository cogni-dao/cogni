// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeEntryView`
 * Purpose: Full-page view of a single knowledge entry — the permalink target.
 *   Fetches the entry by id, renders the shared body + chain walk + a copy-link.
 * Scope: Presentation. Fetches via React Query (cookie-session).
 * Side-effects: IO (GET /api/v1/knowledge/[id]).
 * @internal
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { fetchKnowledgeEntry } from "../_api/fetchKnowledgeEntry";
import { CopyLinkButton } from "./CopyLinkButton";
import { KnowledgeEntryFields } from "./KnowledgeEntryFields";

export function KnowledgeEntryView({ id }: { readonly id: string }) {
  const query = useQuery({
    queryKey: ["knowledge", "entry", id],
    queryFn: () => fetchKnowledgeEntry(id),
    staleTime: 30_000,
    retry: false,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5 md:p-6">
      <Link
        href="/knowledge"
        className="inline-flex w-fit items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Knowledge
      </Link>

      {query.isLoading && (
        <p className="py-12 text-center text-muted-foreground text-sm">
          Loading entry…
        </p>
      )}

      {query.error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
          <p className="font-medium text-sm">Entry not found.</p>
          <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
            No knowledge entry with id <code className="font-mono">{id}</code>{" "}
            exists on <code className="font-mono">main</code>, or it isn't
            visible to you.
          </p>
        </div>
      )}

      {query.data && (
        <>
          <div className="flex flex-col gap-2">
            <span className="font-mono text-muted-foreground text-xs">
              {query.data.domain}
              {query.data.entityId ? ` · ${query.data.entityId}` : ""}
            </span>
            <h1 className="font-semibold text-xl leading-snug tracking-tight md:text-2xl">
              {query.data.title}
            </h1>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-muted-foreground text-xs">
                {query.data.id}
              </span>
              <CopyLinkButton
                path={`/knowledge/${query.data.id}`}
                label="Copy block link"
              />
            </div>
          </div>

          <div className="mt-2">
            <KnowledgeEntryFields item={query.data} showChain={true} />
          </div>
        </>
      )}
    </div>
  );
}
