// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/telemetry/transcripts/route`
 * Purpose: Ingest endpoint for the AI-developer transcript firehose. Accepts a
 *   multipart upload (metadata fields + a `chunk` JSONL file) from the Claude
 *   Code SessionEnd hook, binds it to the authenticated principal, and appends
 *   it to the operator-local raw plane.
 * Scope: Bearer + session auth. HTTP translation only — persistence lives in
 *   `TranscriptIngestPort`. The caller MUST NOT supply identity; `principal_id`
 *   is bound from the authenticated principal so transcripts cannot be forged.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, PRINCIPAL_DERIVES_SOURCE,
 *   IDEMPOTENT_BY_SESSION_CURSOR.
 * Side-effects: IO (HTTP response, Postgres write via container capability)
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const MetaSchema = z.object({
  sessionId: z.string().min(1).max(200),
  cursor: z.coerce.number().int().min(0).default(0),
  repo: z.string().max(500).optional(),
  node: z.string().max(100).optional(),
  headSha: z.string().max(100).optional(),
  branch: z.string().max(300).optional(),
  cwd: z.string().max(1000).optional(),
  transcriptPath: z.string().max(1000).optional(),
});

function field(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "telemetry.transcripts.append",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "expected multipart/form-data" },
        { status: 400 }
      );
    }

    const parsed = MetaSchema.safeParse({
      sessionId: field(form, "sessionId"),
      cursor: field(form, "cursor"),
      repo: field(form, "repo"),
      node: field(form, "node"),
      headSha: field(form, "headSha"),
      branch: field(form, "branch"),
      cwd: field(form, "cwd"),
      transcriptPath: field(form, "transcriptPath"),
    });
    if (!parsed.success)
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );

    const chunk = form.get("chunk");
    if (!(chunk instanceof Blob))
      return NextResponse.json(
        { error: "missing chunk file" },
        { status: 400 }
      );
    if (chunk.size > MAX_CHUNK_BYTES)
      return NextResponse.json({ error: "chunk too large" }, { status: 413 });

    const body = await chunk.text();
    const c = getContainer();
    try {
      const result = await c.transcriptIngest.append({
        principalId: sessionUser.id,
        principalName: sessionUser.displayName,
        sessionId: parsed.data.sessionId,
        cursor: parsed.data.cursor,
        repo: parsed.data.repo ?? null,
        node: parsed.data.node ?? null,
        headSha: parsed.data.headSha ?? null,
        branch: parsed.data.branch ?? null,
        cwd: parsed.data.cwd ?? null,
        transcriptPath: parsed.data.transcriptPath ?? null,
        body,
        byteLen: chunk.size,
      });
      c.log.info(
        {
          route: "telemetry.transcripts.append",
          principalId: sessionUser.id,
          sessionId: parsed.data.sessionId,
          cursor: parsed.data.cursor,
          byteLen: chunk.size,
          deduped: result.deduped,
        },
        "telemetry.transcripts.append"
      );
      return NextResponse.json(
        {
          id: result.id,
          sessionId: parsed.data.sessionId,
          cursor: parsed.data.cursor,
          deduped: result.deduped,
        },
        { status: result.deduped ? 200 : 201 }
      );
    } catch (e) {
      c.log.error(
        { route: "telemetry.transcripts.append", err: String(e) },
        "telemetry.transcripts.append.error"
      );
      return NextResponse.json({ error: "ingest failed" }, { status: 500 });
    }
  }
);
