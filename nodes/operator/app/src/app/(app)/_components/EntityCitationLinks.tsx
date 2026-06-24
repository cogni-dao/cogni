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

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";

import { Badge } from "@/components";
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
  return `${link.citationType} ${endpoint.id}`;
}

export function EntityCitationLinks({
  entityId,
}: EntityCitationLinksProps): ReactElement | null {
  const query = useQuery({
    queryKey: ["citation-links", entityId],
    queryFn: () => fetchCitationLinks(entityId),
    staleTime: 30_000,
  });

  const links = query.data?.links ?? [];
  if (query.isLoading || query.error || links.length === 0) return null;

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
    </div>
  );
}
