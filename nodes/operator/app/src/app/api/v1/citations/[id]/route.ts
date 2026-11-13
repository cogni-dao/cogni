// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/citations/[id]/route`
 * Purpose: GET /api/v1/citations/:id — depth-1 citation links for one
 *   knowledge or work-item endpoint, five metadata links per cursor page.
 * Scope: Authenticated session/bearer read endpoint. Delegates reads through
 *   the knowledge store port; performs no writes or per-endpoint body reads.
 * Invariants: VALIDATE_IO, CITATION_LINKS_ARE_EDGES, DEPTH_1_INDEXED_READ.
 * Side-effects: IO (HTTP response, Doltgres reads)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { readCitationLinksPage } from "@/bootstrap/capabilities/citation-links";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CitationLinksQuerySchema = z.object({
  cursor: z.string().min(1).max(2000).optional(),
});

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "citations.links",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const { id } = await context.params;
    const parsed = CitationLinksQuerySchema.safeParse({
      cursor: new URL(request.url).searchParams.get("cursor") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    }
    const page = await readCitationLinksPage(port, id, parsed.data.cursor);
    ctx.log.info(
      { id, count: page.links.length, hasMore: page.nextCursor !== null },
      "citations.links_success"
    );
    return NextResponse.json(page);
  }
);
