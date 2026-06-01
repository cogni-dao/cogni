// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/[id]/route`
 * Purpose: GET /api/v1/knowledge/[id] — fetch a single knowledge entry for the routable
 *   full-page view (the permalink target humans click and AI emits).
 * Scope: Cookie-session only (Bearer agents rejected with 403, mirroring the list route).
 *   Reads via container.knowledgeStorePort.getKnowledge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION.
 * Side-effects: IO (HTTP response, Doltgres read via container port)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { KnowledgeRowSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.get",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Bearer-token agents must not browse the knowledge plane in v0
    // (KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION). Cookie-session users only.
    const authz = request.headers.get("authorization") ?? "";
    if (authz.toLowerCase().startsWith("bearer ")) {
      return NextResponse.json(
        { error: "knowledge browse requires a session cookie (v0)" },
        { status: 403 }
      );
    }

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    const entry = await port.getKnowledge(id);
    if (!entry) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    ctx.log.info({ id }, "knowledge.get_success");

    return NextResponse.json(
      KnowledgeRowSchema.parse({
        id: entry.id,
        domain: entry.domain,
        entityId: entry.entityId ?? null,
        title: entry.title,
        content: entry.content,
        entryType: entry.entryType ?? "finding",
        confidencePct: entry.confidencePct ?? null,
        sourceType: entry.sourceType,
        sourceRef: entry.sourceRef ?? null,
        tags: entry.tags ?? null,
        createdAt: entry.createdAt ? entry.createdAt.toISOString() : null,
      })
    );
  }
);
