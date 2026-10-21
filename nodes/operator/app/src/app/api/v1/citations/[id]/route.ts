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

import { isWorkItemEndpointId } from "@cogni/knowledge-store";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CitationEndpointSchema = z.object({
  id: z.string(),
  kind: z.enum(["knowledge", "work"]),
  title: z.string().nullable(),
  href: z.string(),
});

const CitationLinkSchema = z.object({
  id: z.string(),
  direction: z.enum(["out", "in"]),
  citationType: z.string(),
  source: CitationEndpointSchema,
  target: CitationEndpointSchema,
  context: z.string().nullable(),
});

const CitationLinksResponseSchema = z.object({
  links: z.array(CitationLinkSchema).max(5),
  nextCursor: z.string().nullable(),
});

const CitationLinksQuerySchema = z.object({
  cursor: z.string().min(1).max(2000).optional(),
});

type CitationEndpoint = z.infer<typeof CitationEndpointSchema>;

function endpoint(id: string, title: string | null): CitationEndpoint {
  const isWork = isWorkItemEndpointId(id);
  return {
    id,
    kind: isWork ? "work" : "knowledge",
    title,
    href: `${isWork ? "/work/items" : "/knowledge"}/${encodeURIComponent(id)}`,
  };
}

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
    const page = await port.listCitationLinks(id, parsed.data.cursor);
    const links = page.links.map((c) => ({
      id: c.id,
      direction: c.citingId === id ? ("out" as const) : ("in" as const),
      citationType: c.citationType,
      source: endpoint(c.citingId, c.sourceTitle),
      target: endpoint(c.citedId, c.targetTitle),
      context: c.context,
    }));
    ctx.log.info(
      { id, count: links.length, hasMore: page.nextCursor !== null },
      "citations.links_success"
    );
    return NextResponse.json(
      CitationLinksResponseSchema.parse({ links, nextCursor: page.nextCursor })
    );
  }
);
