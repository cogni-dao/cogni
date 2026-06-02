// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/route`
 * Purpose: GET /api/v1/knowledge — list knowledge entries across all domains for the human browse UI and external agent recall.
 * Scope: Any authenticated principal (cookie-session human OR bearer agent). Reads via container.knowledgeStorePort: listDomains then per-domain listKnowledge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_REQUIRES_PRINCIPAL.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import {
  KnowledgeListQuerySchema,
  KnowledgeListResponseSchema,
  type KnowledgeRow,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Any authenticated principal may read (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
    // Bearer agents recall the merged plane just like the human browse UI;
    // per-principal x402 metering for external readers remains future work.

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const parsed = KnowledgeListQuerySchema.safeParse({
      domain: url.searchParams.get("domain") ?? undefined,
      sourceType: url.searchParams.get("sourceType") ?? undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid query", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const allDomains = await port.listDomains();
    const targetDomains = parsed.data.domain
      ? allDomains.filter((d) => d === parsed.data.domain)
      : allDomains;

    const items: KnowledgeRow[] = [];
    for (const domain of targetDomains) {
      const rows = await port.listKnowledge(domain, {
        limit: parsed.data.limit,
      });
      for (const r of rows) {
        if (parsed.data.sourceType && r.sourceType !== parsed.data.sourceType) {
          continue;
        }
        items.push({
          id: r.id,
          domain: r.domain,
          entityId: r.entityId ?? null,
          title: r.title,
          content: r.content,
          entryType: r.entryType ?? "finding",
          confidencePct: r.confidencePct ?? null,
          sourceType: r.sourceType,
          sourceRef: r.sourceRef ?? null,
          tags: r.tags ?? null,
          createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        });
        if (items.length >= parsed.data.limit) break;
      }
      if (items.length >= parsed.data.limit) break;
    }

    ctx.log.info(
      { count: items.length, domains: allDomains.length },
      "knowledge.list_success"
    );

    return NextResponse.json(
      KnowledgeListResponseSchema.parse({ items, domains: allDomains })
    );
  }
);
