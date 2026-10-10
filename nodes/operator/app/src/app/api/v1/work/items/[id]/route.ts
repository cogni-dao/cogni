// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET (markdown ∪ Doltgres routed by ID range), PATCH (Doltgres only), and DELETE (Doltgres hard-delete with dolt_log audit).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, PATCH_ALLOWLIST, HARD_DELETE_RECOVERABLE_VIA_DOLT_REVERT, CODED_WRITE_ERRORS.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write/delete)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  deleteWorkItem,
  getWorkItem,
  patchWorkItem,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { workItemsWriteErrorResponse } from "../_errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items/:id — Get a single work item by ID. IDs ≥ 5000 read
 * from Doltgres; below that read from the markdown port.
 */
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.get", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    const item = await getWorkItem(id);

    if (!item) {
      return NextResponse.json(
        { error: `Work item not found: ${id}` },
        { status: 404 }
      );
    }

    ctx.log.info({ workItemId: id }, "work.items.get_success");

    return NextResponse.json(workItemsGetOperation.output.parse(item));
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item (Doltgres only).
 *
 * v0 trusts the bearer of a valid token (no expectedRevision, no transition
 * state-machine — see PATCH_ALLOWLIST). Author embedded in dolt_log.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.patch", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parseResult = workItemsPatchOperation.input.safeParse({
      id,
      ...(typeof body === "object" && body !== null ? body : {}),
    });
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    try {
      const patched = await patchWorkItem(parseResult.data, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      ctx.log.info({ workItemId: id }, "work.items.patch_success");
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (e) {
      // Coded responses: 403 authz_denied (permanent), 503 work_items_busy
      // (retryable), 503 not-ready, 404 missing. Anything unrecognized rethrows
      // to the wrapper's 500 — the catch is NOT broadened (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e);
      if (coded) return coded;
      throw e;
    }
  }
);

/**
 * DELETE /api/v1/work/items/:id — Hard-delete a work item from Doltgres.
 *
 * The deletion is captured as a dolt_log commit; recovery via dolt_revert
 * remains available. Idempotent at the contract level: a missing id returns 404,
 * not 500. Returns `{id, deleted: true}` on success.
 */
export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    const inputParse = workItemsDeleteOperation.input.safeParse({ id });
    if (!inputParse.success) {
      return NextResponse.json(
        { error: "invalid input", issues: inputParse.error.issues },
        { status: 400 }
      );
    }

    try {
      const deleted = await deleteWorkItem(id, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      if (!deleted) {
        return NextResponse.json(
          { error: `Work item not found: ${id}` },
          { status: 404 }
        );
      }
      ctx.log.info({ workItemId: id }, "work.items.delete_success");
      return NextResponse.json(
        workItemsDeleteOperation.output.parse({ id, deleted: true })
      );
    } catch (e) {
      // Same coded mapping as PATCH; unrecognized errors still reach the
      // wrapper's 500 (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e);
      if (coded) return coded;
      throw e;
    }
  }
);
