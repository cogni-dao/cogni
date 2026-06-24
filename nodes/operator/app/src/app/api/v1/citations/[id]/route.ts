// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/citations/[id]/route`
 * Purpose: GET /api/v1/citations/:id — depth-1 citation links for one
 *   knowledge or work-item endpoint, resolved into clickable UI metadata.
 * Scope: Authenticated session/bearer read endpoint. Delegates reads through
 *   the knowledge store port plus work-item facade; performs no writes.
 * Invariants: VALIDATE_IO, CITATION_LINKS_ARE_EDGES, DEPTH_1_INDEXED_READ.
 * Side-effects: IO (HTTP response, Doltgres reads)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getWorkItem } from "@/app/_facades/work/items.server";
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
  links: z.array(CitationLinkSchema),
});

type CitationEndpoint = z.infer<typeof CitationEndpointSchema>;

function isWorkItemEndpointId(id: string): boolean {
  return /^(task|bug|spike|story|subtask)\.\d+$/.test(id);
}

async function resolveEndpoint(id: string): Promise<CitationEndpoint> {
  if (isWorkItemEndpointId(id)) {
    const item = await getWorkItem(id);
    return {
      id,
      kind: "work",
      title: item?.title ?? null,
      href: `/work?q=${encodeURIComponent(id)}`,
    };
  }

  const entry = await getContainer().knowledgeStorePort?.getKnowledge(id);
  return {
    id,
    kind: "knowledge",
    title: entry?.title ?? null,
    href: `/knowledge/${encodeURIComponent(id)}`,
  };
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "citations.links",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
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
    const [outgoing, incoming] = await Promise.all([
      port.listCitationsByCitingId(id),
      port.listCitationsByCitedId(id),
    ]);

    const endpointCache = new Map<string, Promise<CitationEndpoint>>();
    const endpointFor = (endpointId: string): Promise<CitationEndpoint> => {
      const cached = endpointCache.get(endpointId);
      if (cached) return cached;
      const promise = resolveEndpoint(endpointId);
      endpointCache.set(endpointId, promise);
      return promise;
    };

    const links = await Promise.all([
      ...outgoing.map(async (c) => ({
        id: c.id,
        direction: "out" as const,
        citationType: c.citationType,
        source: await endpointFor(c.citingId),
        target: await endpointFor(c.citedId),
        context: c.context ?? null,
      })),
      ...incoming.map(async (c) => ({
        id: c.id,
        direction: "in" as const,
        citationType: c.citationType,
        source: await endpointFor(c.citingId),
        target: await endpointFor(c.citedId),
        context: c.context ?? null,
      })),
    ]);

    ctx.log.info({ id, count: links.length }, "citations.links_success");

    return NextResponse.json(CitationLinksResponseSchema.parse({ links }));
  }
);
