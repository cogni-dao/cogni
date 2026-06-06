// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/route`
 * Purpose: HTTP endpoints for the knowledge domain registry — GET list with entry counts and POST register a new domain.
 * Scope: Cookie-session only. Does not contain business logic; delegates to _handlers.ts and the container's KnowledgeStorePort.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, DOMAIN_HTTP_COOKIE_ONLY,
 *   DOMAIN_REGISTRY_VIA_UI, DOMAIN_REGISTER_AUTOCOMMITS.
 * Side-effects: IO (HTTP response, Doltgres read/write via container port)
 * Links: docs/spec/knowledge-domain-registry.md
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleCreate, handleList } from "./_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.domains.list",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleList(request, sessionUser)
);

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.domains.create",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleCreate(request, sessionUser)
);
