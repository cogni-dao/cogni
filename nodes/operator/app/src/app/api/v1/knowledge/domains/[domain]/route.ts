// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/[domain]/route`
 * Purpose: Item domain read, metadata update and empty-domain deletion.
 * Scope: Bearer/session auth and transport delegation; no storage or admission logic.
 * Invariants: Same principal requirement as domain registration; ID immutable; no cascade.
 * Side-effects: IO via authenticated domain handlers
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @public
 */
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDelete, handleGet, handleUpdate } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type DomainContext = { params: Promise<{ domain: string }> };

export const GET = wrapRouteHandlerWithLogging<DomainContext>(
  {
    routeId: "knowledge.domains.get",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleGet((await context.params).domain, sessionUser);
  }
);
export const PATCH = wrapRouteHandlerWithLogging<DomainContext>(
  {
    routeId: "knowledge.domains.update",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleUpdate(request, (await context.params).domain, sessionUser);
  }
);
export const DELETE = wrapRouteHandlerWithLogging<DomainContext>(
  {
    routeId: "knowledge.domains.delete",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleDelete((await context.params).domain, sessionUser);
  }
);
