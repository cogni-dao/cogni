// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/export/route`
 * Purpose: GET /api/v1/knowledge/export?format=obsidian — stream a zipped Obsidian vault of the knowledge hub (one Markdown note per entry, domain folders, citations as `[[wikilinks]]`).
 * Scope: Dual-access (agents via Bearer + humans via session cookie — getSessionUser is agent-first). Reads via container.knowledgeStorePort, serializes with buildObsidianVault, zips with fflate.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER (resolveRequestIdentity: Bearer → cookie fallback). Export is a snapshot capability agents already hold at the tool layer, so unlike browse it is NOT session-gated.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Status: v0 prototype — agent-accessible API kept; human UI (Export button) deactivated pending refinement (story.5007: provenance-named archive, grouping, human-readable names, HTML handling, AI setup guide).
 * Links: ./_lib/obsidian-vault.ts, ../route.ts, docs/spec/knowledge-syntropy.md
 * @public
 */

import { zipSync } from "fflate";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { buildObsidianVault, type VaultEntry } from "./_lib/obsidian-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ExportQuerySchema = z.object({
  format: z.enum(["obsidian"]).default("obsidian"),
  domain: z.string().min(1).optional(),
});

// Per-domain row cap for a single export. Generous — exports are a bounded
// admin action, not a hot path.
const PER_DOMAIN_LIMIT = 10_000;

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.export",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Dual-access by design: getSessionUser === resolveRequestIdentity is
    // agent-first (Bearer token → session-cookie fallback), so both agents and
    // humans can export. Unlike the browse dashboard, export is a snapshot
    // capability agents already have at the tool layer (core__knowledge_*).

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const parsed = ExportQuerySchema.safeParse({
      format: url.searchParams.get("format") ?? undefined,
      domain: url.searchParams.get("domain") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid query", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const allDomains = await port.listDomainsFull();
    const targetDomains = parsed.data.domain
      ? allDomains.filter((d) => d.id === parsed.data.domain)
      : allDomains;
    if (parsed.data.domain && targetDomains.length === 0) {
      return NextResponse.json(
        { error: `domain '${parsed.data.domain}' not found` },
        { status: 404 }
      );
    }

    const entries: VaultEntry[] = [];
    for (const domain of targetDomains) {
      const rows = await port.listKnowledge(domain.id, {
        limit: PER_DOMAIN_LIMIT,
      });
      for (const entry of rows) {
        const citations = await port.listCitationsByCitingId(entry.id);
        entries.push({ entry, citations });
      }
    }

    const files = buildObsidianVault({ domains: targetDomains, entries });

    const encoder = new TextEncoder();
    const zipInput: Record<string, Uint8Array> = {};
    for (const file of files) {
      zipInput[file.path] = encoder.encode(file.content);
    }
    const zipped = zipSync(zipInput, { level: 6 });
    // Copy into a fresh ArrayBuffer: fflate returns Uint8Array<ArrayBufferLike>,
    // which the DOM `BodyInit` type does not accept directly.
    const body = new ArrayBuffer(zipped.byteLength);
    new Uint8Array(body).set(zipped);

    ctx.log.info(
      {
        entries: entries.length,
        domains: targetDomains.length,
        files: files.length,
        bytes: zipped.byteLength,
      },
      "knowledge.export_success"
    );

    const suffix = parsed.data.domain
      ? parsed.data.domain.replace(/[^a-zA-Z0-9_-]+/g, "-")
      : "vault";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="cogni-knowledge-${suffix}.zip"`,
        "cache-control": "no-store",
      },
    });
  }
);
