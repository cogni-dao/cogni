// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/_components/EntityCitationLinks`
 * Purpose: Render depth-1 citation edges for a knowledge or work-item endpoint
 *   as compact clickable chips.
 * Scope: Node routing, transport, and chip presentation. No pagination or write policy.
 * Side-effects: IO (GET /api/v1/citations/:id via fetchCitationLinks)
 * @internal
 */

"use client";

import {
  DirectRelationLinks,
  formatCitationLabel,
} from "@cogni/knowledge-base-ui";
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
  return formatCitationLabel(link.citationType, endpoint);
}

export function EntityCitationLinks({
  entityId,
}: EntityCitationLinksProps): ReactElement | null {
  return (
    <DirectRelationLinks
      entityId={entityId}
      loadPage={fetchCitationLinks}
      className="flex flex-col gap-1"
      headingClassName="font-medium text-muted-foreground text-xs uppercase tracking-wider"
      linksClassName="flex flex-wrap gap-1.5"
      moreButtonClassName="w-fit rounded border px-2 py-1 text-xs disabled:opacity-50"
      renderLink={(link) => {
        const endpoint = otherEndpoint(link, entityId);
        return (
          <Link href={endpoint.href} title={endpoint.title ?? endpoint.id}>
            <Badge intent="outline" size="sm">
              <span className="font-mono">{chipLabel(link, entityId)}</span>
            </Badge>
          </Link>
        );
      }}
    />
  );
}
