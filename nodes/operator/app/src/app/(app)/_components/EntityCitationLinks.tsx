// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/_components/EntityCitationLinks`
 * Purpose: Render depth-1 citation edges for a knowledge or work-item endpoint
 *   as compact clickable chips.
 * Scope: Protected app presentation plus React Query fetch. No write policy.
 * Side-effects: IO (GET /api/v1/citations/:id via fetchCitationLinks)
 * @internal
 */

"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";

import { Badge, Button } from "@/components";
import {
  type CitationLinkDto,
  fetchCitationLinks,
} from "../_api/fetchCitationLinks";

interface EntityCitationLinksProps {
  readonly entityId: string;
}

function otherEndpoint(link: CitationLinkDto, entityId: string) {
  return link.source.id === entityId ? link.target : link.source;
}

function chipLabel(link: CitationLinkDto, entityId: string): string {
  const endpoint = otherEndpoint(link, entityId);
  return `${link.citationType} ${endpoint.title ?? endpoint.id}`;
}

export function EntityCitationLinks({
  entityId,
}: EntityCitationLinksProps): ReactElement | null {
  const query = useInfiniteQuery({
    queryKey: ["citation-links", entityId, "pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchCitationLinks(entityId, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const links = query.data?.pages.flatMap((page) => page.links) ?? [];
  if (query.error && links.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">Unable to load links.</p>
    );
  }
  if (query.isLoading || links.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        Links
      </span>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link) => {
          const endpoint = otherEndpoint(link, entityId);
          return (
            <Link
              key={`${link.direction}-${link.id}`}
              href={endpoint.href}
              title={endpoint.title ?? endpoint.id}
            >
              <Badge intent="outline" size="sm">
                <span className="font-mono">{chipLabel(link, entityId)}</span>
              </Badge>
            </Link>
          );
        })}
      </div>
      {query.hasNextPage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading links…" : "More links"}
        </Button>
      )}
      {query.error && (
        <p className="text-muted-foreground text-xs">
          Unable to load more links.
        </p>
      )}
    </div>
  );
}
