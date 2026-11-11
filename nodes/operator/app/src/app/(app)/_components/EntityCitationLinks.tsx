// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/_components/EntityCitationLinks`
 * Purpose: Render depth-1 citation edges for a knowledge or work-item endpoint
 *   as the package's arrow, relation and slug rows.
 * Scope: Node routing and transport only; links open entries in the side sheet. Presentation and paging live in
 *   `@cogni/knowledge-base-ui` `CitationLinks`.
 * Side-effects: IO (GET /api/v1/citations/:id via fetchCitationLinks)
 * @internal
 */

"use client";

import { CitationLinks } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { fetchCitationLinks } from "../_api/fetchCitationLinks";
import { PeekLink } from "./EntityPeek";

interface EntityCitationLinksProps {
  readonly entityId: string;
}

export function EntityCitationLinks({
  entityId,
}: EntityCitationLinksProps): ReactElement | null {
  return (
    <CitationLinks
      entityId={entityId}
      loadPage={fetchCitationLinks}
      LinkComponent={PeekLink}
    />
  );
}
