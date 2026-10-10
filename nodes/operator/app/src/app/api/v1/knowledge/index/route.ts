// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/index/route`
 * Purpose: GET /api/v1/knowledge/index — the routing projection. Returns id + entryType + retrieval trigger per entry WITHOUT content, so an agent can choose a shelf entry without downloading bodies, optionally filtered to the triggers matching `?q=`.
 * Scope: Any authenticated principal (cookie-session human OR bearer agent), mirroring the list route. Reads via container.knowledgeStorePort. Does not search titles or bodies — `q` matches the retrieval trigger only.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_REQUIRES_PRINCIPAL, INDEX_CARRIES_NO_CONTENT, Q_MATCHES_USEWHEN_ONLY.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: packages/node-contracts/src/knowledge.index.v1.contract.ts
 * @public
 */

import {
  KnowledgeIndexQuerySchema,
  KnowledgeIndexResponseSchema,
  type KnowledgeIndexRow,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.index",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const parsed = KnowledgeIndexQuerySchema.safeParse({
      domain: url.searchParams.get("domain") ?? undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid query", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { domain, limit, q } = parsed.data;

    const allDomains = await port.listDomains();
    const targets = domain
      ? allDomains.filter((d) => d === domain)
      : allDomains;

    // Q_MATCHES_USEWHEN_ONLY: the port filters on `useWhen`, so `total` below
    // reports matches considered, not shelf size — a caller can still detect a
    // truncating `limit`.
    const perDomain = await Promise.all(
      targets.map((d) => port.listKnowledge(d, { limit, ...(q ? { q } : {}) }))
    );

    // Project explicitly. INDEX_CARRIES_NO_CONTENT: content and title are
    // dropped here on purpose — `id` names the subject and `useWhen` names the
    // reader's situation, which is what routing needs. Anything more makes this
    // a second browse endpoint.
    const all = perDomain.flat();
    const items: KnowledgeIndexRow[] = all.slice(0, limit).map((r) => ({
      id: r.id,
      domain: r.domain,
      entryType: r.entryType ?? "finding",
      useWhen: r.useWhen ?? null,
    }));

    const body = KnowledgeIndexResponseSchema.parse({
      items,
      domains: allDomains,
      total: all.length,
    });

    ctx.log.info(
      {
        count: items.length,
        total: all.length,
        domain: domain ?? null,
        q: q ?? null,
      },
      "knowledge.index_success"
    );

    return NextResponse.json(body);
  }
);
