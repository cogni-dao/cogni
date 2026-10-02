// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/[id]/route`
 * Purpose: Guarded deletion for one node-local knowledge domain.
 * Scope: Authenticated Bearer agents and session users. Delegates usage checks
 *   and Dolt auto-commit to KnowledgeStorePort.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER,
 *   DOMAIN_DELETE_EMPTY_ONLY, DOMAIN_DELETE_AUTOCOMMITS.
 * Side-effects: IO (HTTP response, Doltgres read/write via container port)
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDelete } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.domains.delete",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const response = await handleDelete(id, sessionUser);
    if (response.ok) {
      ctx.log.info({ domain: id }, "knowledge.domains.delete_success");
    } else if (response.status === 409) {
      ctx.log.info({ domain: id }, "knowledge.domains.delete_conflict");
    }
    return response;
  }
);
