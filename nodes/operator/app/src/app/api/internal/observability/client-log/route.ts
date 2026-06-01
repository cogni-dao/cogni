// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/observability/client-log`
 * Purpose: Ingest best-effort client-side warn/error logs so browser failures
 *   (e.g. wallet tx reverts) are observable server-side in Loki instead of dying
 *   in the user's console.
 * Scope: Accepts {level, event, meta} from clientLogger; re-emits via the request
 *   logger (Pino -> Loki). Does not authenticate (browser-callable); does not persist.
 * Invariants: Never trusts client level beyond warn|error; bounds event length; no PII keys
 *   (clientLogger already scrubs forbidden keys + truncates before shipping).
 * Side-effects: IO (structured log line).
 * Notes: v0 — unauthenticated + unbounded; add rate-limiting / origin checks as follow-up (bug.5087).
 * Links: packages/node-shared/src/observability/client/logger.ts, bug.5087
 * @internal
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ClientLogSchema = z.object({
  level: z.enum(["warn", "error"]),
  event: z.string().min(1).max(200),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "observability.client_log", auth: { mode: "none" } },
  async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = ClientLogSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid client log" },
        { status: 400 }
      );
    }

    const { level, event, meta } = parsed.data;
    const payload = { event: `client_log.${event}`, source: "client", meta };
    if (level === "error") {
      ctx.log.error(payload, "client log");
    } else {
      ctx.log.warn(payload, "client log");
    }

    return new NextResponse(null, { status: 204 });
  }
);
