// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/bootstrap/route`
 * Purpose: GET /api/v1/knowledge/bootstrap — the node's "cognition substrate"
 *   kickstart bundle. Composes the irreducible session invariants (code-owned)
 *   with a live skills index + domain pointers from the knowledge hub, plus a
 *   rendered markdown bundle a SessionStart hook echoes into agent context.
 * Scope: Single public GET. Reads via container.knowledgeStorePort. Public
 *   (auth: none) and index-only — like /.well-known/agent.json. Full entry
 *   bodies stay behind the authed read routes (KNOWLEDGE_READ_REQUIRES_PRINCIPAL).
 * Invariants:
 *   - INDEX_NOT_CONTENT: returns skill/domain pointers, never full bodies.
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: invariants + markdown render even
 *     when the hub is unconfigured or empty.
 *   - NO_INTERNAL_BIND_ADDR: origin derived from forwarded headers first.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/node-baas-architecture.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import {
  type BootstrapDomainPointer,
  type BootstrapSkillPointer,
  KnowledgeBootstrapResponseSchema,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import {
  deriveUseWhen,
  isCognitionEntry,
  renderBundleMarkdown,
  SESSION_BOOTSTRAP_INVARIANTS,
} from "./_bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PER_DOMAIN_LIMIT = 50;

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
  { routeId: "knowledge.bootstrap", auth: { mode: "none" } },
  async (ctx, request) => {
    const container = getContainer();
    const origin = publicOrigin(request);
    const node = container.nodeId;
    const buildSha = serverEnv().APP_BUILD_SHA ?? "unknown";

    const skillsIndex: BootstrapSkillPointer[] = [];
    const domainPointers: BootstrapDomainPointer[] = [];

    // Cognition is delivered live from the hub; the irreducible invariants below
    // are the only piece that must survive an unconfigured/empty hub.
    const port = container.knowledgeStorePort;
    if (port) {
      const domains = await port.listDomainsFull();
      for (const d of domains) {
        domainPointers.push({
          domain: d.id,
          description: d.description,
          entryCount: d.entryCount,
        });
        const rows = await port.listKnowledge(d.id, {
          limit: PER_DOMAIN_LIMIT,
        });
        for (const r of rows) {
          if (!isCognitionEntry(r.entryType)) continue;
          skillsIndex.push({
            id: r.id,
            title: r.title,
            useWhen: deriveUseWhen(r.content, r.title),
            entryType: r.entryType ?? "guide",
            domain: r.domain,
          });
        }
      }
    }

    const toolingInvariants = [...SESSION_BOOTSTRAP_INVARIANTS];
    const recallProtocol =
      `RECALL both planes before writing: merged via GET ${origin}/api/v1/knowledge?domain=<domain>, ` +
      `and your open contribution branch via GET ${origin}/api/v1/knowledge/contributions/{id}/diff. ` +
      "Refine in place over writing new (REFINE_OVER_EXTEND).";

    const markdown = renderBundleMarkdown({
      node,
      origin,
      buildSha,
      toolingInvariants,
      skillsIndex,
      domainPointers,
    });

    ctx.log.info(
      {
        node,
        skills: skillsIndex.length,
        domains: domainPointers.length,
        hub: Boolean(port),
      },
      "knowledge.bootstrap_success"
    );

    return NextResponse.json(
      KnowledgeBootstrapResponseSchema.parse({
        node,
        version: "v1",
        buildSha,
        generatedAt: new Date().toISOString(),
        toolingInvariants,
        skillsIndex,
        domainPointers,
        recallProtocol,
        markdown,
      })
    );
  }
);
