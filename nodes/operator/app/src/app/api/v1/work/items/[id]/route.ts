// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET/PATCH and retired DELETE response; does not implement persistence or allow hard deletion.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, PATCH_ALLOWLIST, DURABLE_IDENTITY_NEVER_REUSED, CODED_WRITE_ERRORS.
 * Reason + cites (task.0086): a missing or over-cap reason is HTTP 400 `invalid input` with an issue at `reason`; an unknown cite id or a closed inbox is HTTP 400 `cite_unresolved`; cites with no resolver wired is HTTP 400 `cites_unsupported`; a resolver failure is HTTP 503. Nothing is written in each case.
 * Moves (story.0033): `set.moves` with an unknown or deprecated metric id is HTTP 400 `cite_unresolved` with an issue at `set.moves`; a bad list is HTTP 400 `moves_invalid`; a non-empty list with no metric wiring is HTTP 400 `moves_unsupported`; a baseline failure is HTTP 503 `metric_baseline_unavailable`. The client never sets a baseline: the server pins it. The GET, PATCH response adds each move's baseline, current reading and verdict.
 * Envelope (task.0118): GET returns each `moves` entry with its metric, KPI and goal; `?include=links` adds the first page of citation links (same read as /api/v1/citations/{id}); an unknown include is HTTP 400.
 * Read core (story.0085): `handleWorkItemGet` from @cogni/work-items parses `include`/`artifact`, refuses 400/404 and returns the one terminal event; this route keeps only auth and the store read.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write/delete)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { handleWorkItemGet } from "@cogni/work-items";
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
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    // The package owns the `include`/`artifact` parse, the 400/404/503/499 refusals and the one terminal event (story.0085).
    const result = await handleWorkItemGet(id, {
      searchParams: new URL(request.url).searchParams,
      signal: request.signal,
      read: (itemId, options) =>
        getWorkItem(itemId, { signal: request.signal, ...options }),
      toBody: (item) => workItemsGetOperation.output.parse(item),
    });
    ctx.log.info(result.event, result.event.event);
    return NextResponse.json(result.body, { status: result.status });
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item (Doltgres only).
 *
 * Trusts the bearer of a valid token; the author is recorded for attribution,
 * not used as a gate (bug.5619). No transition state-machine — see
 * PATCH_ALLOWLIST. Optional top-level `expectedRevision` is compare-and-set: a moved row answers 409
 * `revision_conflict` with `currentRevision`. Author embedded in dolt_log.
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
      ctx.log.info(
        { workItemId: id, citeCount: parseResult.data.cites?.length ?? 0 },
        "work.items.patch_success"
      );
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (e) {
      // Coded responses: 400 work_item_scores_invalid (story.5111), 403
      // authz_denied (permanent), 409 revision_conflict
      // (CAS lost, nothing written), 503 work_items_busy (retryable), 503
      // not-ready, 404 missing. Anything unrecognized rethrows
      // to the wrapper's 500 — the catch is NOT broadened (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e);
      if (coded) return coded;
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
