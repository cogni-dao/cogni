// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/route`
 * Purpose: GET /api/v1/cognition — the node's session-start cognition substrate
 *   bundle. Composes the irreducible session invariants (code-owned)
 *   with a live skills index + domain pointers from the knowledge hub, plus a
 *   rendered markdown bundle a SessionStart hook echoes into agent context.
 * Scope: Single authed GET (any principal: cookie-session human OR bearer
 *   agent). Reads via container.knowledgeStorePort. Index-first — full entry
 *   bodies stay behind the same authed read routes (KNOWLEDGE_READ_REQUIRES_PRINCIPAL),
 *   save one bounded current-node orientation excerpt.
 *   The public bootstrap seam stays /api/v1/agent/register: register → key → cognition.
 * Invariants:
 *   - INDEX_FIRST: returns skill/domain pointers + one bounded orientation
 *     excerpt, never full entry bodies.
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: invariants + markdown render even
 *     when the hub is unconfigured or empty.
 *   - NO_INTERNAL_BIND_ADDR: origin derived from forwarded headers first.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/node-baas-architecture.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import {
  CognitionBundleResponseSchema,
  type CognitionDomainPointer,
  type CognitionSkillPointer,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeMission, getNodeName } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import {
  excerptFromContent,
  isCognitionEntry,
  type OrientationExcerpt,
  renderBundleMarkdown,
  SESSION_BOOTSTRAP_INVARIANTS,
} from "./_bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PER_DOMAIN_LIMIT = 50;
// Authed but principal-agnostic (index-only, identical for every caller) + does
// N+1 Doltgres reads; cache privately so repeated session starts collapse to one
// DB pass per window instead of hammering the hub.
const CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";

/** External origin this request reached us through (forwarded headers first). */
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "cognition.bundle",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const container = getContainer();
    const origin = publicOrigin(request);
    const node = container.nodeId;
    const name = getNodeName();
    const mission = getNodeMission();
    const buildSha = serverEnv().APP_BUILD_SHA ?? "unknown";
    const generatedAt = new Date().toISOString();

    const skillsIndex: CognitionSkillPointer[] = [];
    const domainPointers: CognitionDomainPointer[] = [];
    // The current node's orientation entry id, by `<slug>-agent-orientation`
    // convention — captured during the scan, its excerpt fetched below. A
    // node-specific entry (`<name>-agent-orientation`) wins over the generic
    // `cogni-agent-orientation` starter seed every node inherits.
    const exactOrientationId = `${name}-agent-orientation`;
    let orientationId: string | null = null;

    // Cognition is delivered live from the hub; the irreducible invariants below
    // are the only piece that must survive an unconfigured/empty hub.
    const port = container.knowledgeStorePort;
    if (port) {
      const domains = await port.listDomainsFull();
      for (const d of domains) {
        // Suppress empty domains (e.g. a placeholder `nodes` with 0 entries):
        // a bare count is noise in a precious index.
        if (d.entryCount === 0) continue;
        domainPointers.push({
          domain: d.id,
          description: d.description,
          entryCount: d.entryCount,
        });
        const rows = await port.listKnowledge(d.id, {
          limit: PER_DOMAIN_LIMIT,
        });
        for (const r of rows) {
          if (r.id === exactOrientationId) {
            orientationId = r.id;
          } else if (!orientationId && r.id.endsWith("-agent-orientation")) {
            orientationId = r.id;
          }
          if (!isCognitionEntry(r.entryType)) continue;
          skillsIndex.push({
            id: r.id,
            title: r.title,
            entryType: r.entryType ?? "guide",
            domain: r.domain,
          });
        }
      }
    }

    let orientation: OrientationExcerpt | null = null;
    if (port && orientationId) {
      const entry = await port.getKnowledge(orientationId);
      if (entry) {
        orientation = {
          id: entry.id,
          excerpt: excerptFromContent(entry.content),
        };
      }
    }

    const toolingInvariants = [...SESSION_BOOTSTRAP_INVARIANTS];
    const recallProtocol =
      `RECALL both planes before writing: merged via GET ${origin}/api/v1/knowledge?domain=<domain>, ` +
      `and your open contribution branch via GET ${origin}/api/v1/knowledge/contributions/{id}/diff. ` +
      "Refine in place over writing new (REFINE_OVER_EXTEND).";

    const markdown = renderBundleMarkdown({
      node,
      name,
      mission,
      generatedAt,
      origin,
      buildSha,
      toolingInvariants,
      skillsIndex,
      domainPointers,
      orientation,
    });

    ctx.log.info(
      {
        node,
        name,
        skills: skillsIndex.length,
        domains: domainPointers.length,
        orientation: orientation?.id ?? null,
        hub: Boolean(port),
      },
      "cognition.bundle_success"
    );

    const response = NextResponse.json(
      CognitionBundleResponseSchema.parse({
        node,
        name,
        mission,
        version: "v1",
        buildSha,
        generatedAt,
        toolingInvariants,
        skillsIndex,
        domainPointers,
        recallProtocol,
        markdown,
      })
    );
    response.headers.set("Cache-Control", CACHE_CONTROL);
    return response;
  }
);
