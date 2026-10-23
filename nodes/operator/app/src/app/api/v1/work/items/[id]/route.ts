// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET/PATCH and retired DELETE response; does not implement persistence or allow hard deletion.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTHENTICATED_PRINCIPAL, PATCH_ALLOWLIST, DURABLE_IDENTITY_NEVER_REUSED, CODED_WRITE_ERRORS.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write/delete)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  type RequestPrincipal,
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  deleteWorkItem,
  getWorkItem,
  patchWorkItem,
  patchWorkItemAsPrincipal,
} from "@/app/_facades/work/items.server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemsWriteErrorResponse } from "../_errors";
import { workItemTerminal } from "../_observability";

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
    const terminal = workItemTerminal(ctx, performance.now(), "get");
    if (!context) {
      terminal.internalError();
      throw new Error("context required for dynamic routes");
    }
    try {
      const { id } = await context.params;

      const item = await getWorkItem(id);

      if (!item) {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "not_found",
          reasonCode: "work_item_not_found",
        });
        return NextResponse.json(
          { error: `Work item not found: ${id}` },
          { status: 404 }
        );
      }

      const output = workItemsGetOperation.output.parse(item);
      terminal.complete({
        status: 200,
        outcome: "success",
        dimensions: { itemFound: true },
      });
      return NextResponse.json(output);
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item (Doltgres only).
 *
 * Trusts the bearer of a valid token under the store's author-scoped authority
 * (no transition state-machine — see PATCH_ALLOWLIST). Optional top-level
 * `expectedRevision` is compare-and-set: a moved row answers 409
 * `revision_conflict` with `currentRevision`. Author embedded in dolt_log.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.patch", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, context) => {
    const terminal = workItemTerminal(ctx, performance.now(), "patch");
    if (!context) {
      terminal.internalError();
      throw new Error("context required for dynamic routes");
    }
    let principal: RequestPrincipal | null;
    try {
      principal = await resolveRequestPrincipal();
    } catch (error) {
      if (error instanceof RequestIdentityUnavailableError) {
        terminal.complete({
          status: 503,
          outcome: "error",
          errorCode: "identity_unavailable",
          reasonCode: "identity_service_unavailable",
        });
        return NextResponse.json(
          { error: "identity service unavailable" },
          { status: 503 }
        );
      }
      terminal.internalError();
      throw error;
    }
    if (!principal) {
      terminal.complete({
        status: 401,
        outcome: "error",
        errorCode: "unauthorized",
        reasonCode: "principal_missing",
      });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      terminal.complete({
        status: 400,
        outcome: "error",
        errorCode: "invalid_json",
        reasonCode: "invalid_json_body",
      });
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parseResult = workItemsPatchOperation.input.safeParse({
      id,
      ...(typeof body === "object" && body !== null ? body : {}),
    });
    if (!parseResult.success) {
      terminal.complete({
        status: 400,
        outcome: "error",
        errorCode: "invalid_input",
        reasonCode: "contract_validation_failed",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    try {
      let patched: Awaited<ReturnType<typeof patchWorkItem>>;
      if (principal.kind !== "human") {
        patched = await patchWorkItemAsPrincipal(
          parseResult.data,
          principal.principalId
        );
      } else {
        patched = await patchWorkItem(parseResult.data, {
          id: principal.userId,
          displayName: principal.displayName,
        });
      }
      const output = workItemsPatchOperation.output.parse(patched);
      terminal.complete({ status: 200, outcome: "success" });
      return NextResponse.json(output);
    } catch (e) {
      // Coded responses: 403 authz_denied (permanent), 409 revision_conflict
      // (CAS lost, nothing written), 503 work_items_busy (retryable), 503
      // not-ready, 404 missing. Anything unrecognized rethrows
      // to the wrapper's 500 — the catch is NOT broadened (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e, (mapped) =>
        terminal.complete({
          status: mapped.status,
          outcome: "error",
          errorCode: mapped.errorCode,
          reasonCode: mapped.errorCode,
        })
      );
      if (coded) return coded;
      terminal.internalError();
      throw e;
    }
  }
);

/**
 * DELETE /api/v1/work/items/:id — Retired by the shared content adapter.
 *
 * Returns a coded 410 directing callers to PATCH status=cancelled. The shared
 * adapter refuses before SQL, preserving durable item identity and provenance.
 */
export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    const terminal = workItemTerminal(ctx, performance.now(), "delete");
    if (!context) {
      terminal.internalError();
      throw new Error("context required for dynamic routes");
    }
    if (!sessionUser) {
      terminal.complete({
        status: 401,
        outcome: "error",
        errorCode: "unauthorized",
        reasonCode: "session_missing",
      });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    const inputParse = workItemsDeleteOperation.input.safeParse({ id });
    if (!inputParse.success) {
      terminal.complete({
        status: 400,
        outcome: "error",
        errorCode: "invalid_input",
        reasonCode: "contract_validation_failed",
      });
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
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "not_found",
          reasonCode: "work_item_not_found",
        });
        return NextResponse.json(
          { error: `Work item not found: ${id}` },
          { status: 404 }
        );
      }
      const output = workItemsDeleteOperation.output.parse({
        id,
        deleted: true,
      });
      terminal.complete({
        status: 200,
        outcome: "success",
        dimensions: { deleted: true },
      });
      return NextResponse.json(output);
    } catch (e) {
      // Same coded mapping as PATCH; unrecognized errors still reach the
      // wrapper's 500 (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e, (mapped) =>
        terminal.complete({
          status: mapped.status,
          outcome: "error",
          errorCode: mapped.errorCode,
          reasonCode: mapped.errorCode,
        })
      );
      if (coded) return coded;
      terminal.internalError();
      throw e;
    }
  }
);
