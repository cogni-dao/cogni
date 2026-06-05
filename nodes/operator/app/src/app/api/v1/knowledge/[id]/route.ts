// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/[id]/route`
 * Purpose: GET /api/v1/knowledge/[id] — fetch a single knowledge entry for the routable
 *   full-page view (the permalink target humans click and AI emits).
 * Scope: Any authenticated principal (cookie-session human OR bearer agent), mirroring the list route.
 *   Reads via container.knowledgeStorePort.getKnowledge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_REQUIRES_PRINCIPAL.
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
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Any authenticated principal may read (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
    // Bearer agents recall merged entries just like the human browse UI;
    // per-principal x402 metering for external readers remains future work.

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
