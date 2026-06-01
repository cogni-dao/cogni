// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/telemetry/transcripts`
 * Purpose: HTTP contract + persistence test for the AI-developer transcript
 *   ingest endpoint. Proves a multipart upload lands an append-only row in
 *   `agent_transcript_chunks` bound to the authenticated principal, that
 *   re-uploading the same (sessionId, cursor) de-dups, and that auth is enforced.
 * Scope: Real Postgres via testcontainers; route handler invoked directly.
 * Invariants: PRINCIPAL_DERIVES_SOURCE, IDEMPOTENT_BY_SESSION_CURSOR, VALIDATE_IO.
 * Side-effects: IO (database via test harness).
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock session auth (mirrors tests/component/db/routes-contract.int.test.ts).
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as appendTranscript } from "@/app/api/v1/telemetry/transcripts/route";
import { agentTranscriptChunks } from "@/shared/db/agent-transcripts";
import { users } from "@/shared/db/schema";

const ENDPOINT = "http://localhost:3000/api/v1/telemetry/transcripts";

let seedCounter = 1;

function multipart(fields: Record<string, string>, chunk: string): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set(
    "chunk",
    new Blob([chunk], { type: "application/x-ndjson" }),
    "transcript.jsonl"
  );
  return form;
}

function post(form: FormData): Promise<Response> {
  return appendTranscript(
    new NextRequest(ENDPOINT, { method: "POST", body: form })
  );
}

describe("POST /api/v1/telemetry/transcripts (Component)", () => {
  let principal: SessionUser;
  let principalId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const seeded = await seedAuthenticatedUser(getSeedDb(), {
      id: randomUUID(),
      walletAddress: `0x${(seedCounter++).toString(16).padStart(40, "0")}`,
      name: "Transcript Test Agent",
    });
    principalId = seeded.user.id;
    principal = {
      id: seeded.user.id,
      walletAddress: seeded.user.walletAddress ?? null,
    };
    vi.mocked(getSessionUser).mockResolvedValue(principal);
  });

  afterEach(async () => {
    await getSeedDb().delete(users).where(eq(users.id, principalId));
  });

  it("lands an append-only row bound to the authenticated principal", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = await post(
      multipart(
        {
          sessionId,
          cursor: "0",
          repo: "git@github.com:Cogni-DAO/cogni.git",
          headSha: "d430365dc8b6b31cc4386e9749684acd9fd13b49",
          branch: "feat/transcript-telemetry",
        },
        '{"type":"user","content":"hello"}\n{"type":"assistant","content":"hi"}\n'
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ sessionId, cursor: 0, deduped: false });

    const [row] = await getSeedDb()
      .select()
      .from(agentTranscriptChunks)
      .where(
        and(
          eq(agentTranscriptChunks.sessionId, sessionId),
          eq(agentTranscriptChunks.principalId, principalId)
        )
      );
    expect(row).toBeDefined();
    expect(row?.principalId).toBe(principalId);
    expect(row?.repo).toBe("git@github.com:Cogni-DAO/cogni.git");
    expect(row?.headSha).toBe("d430365dc8b6b31cc4386e9749684acd9fd13b49");
    expect(row?.body).toContain("assistant");
    expect(row?.byteLen).toBeGreaterThan(0);
    expect(row?.harvestedAt).toBeNull();
  });

  it("de-dups on (sessionId, cursor) — replay returns 200 deduped, no duplicate row", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const fields = { sessionId, cursor: "0" };

    const first = await post(multipart(fields, '{"a":1}\n'));
    expect(first.status).toBe(201);
    expect((await first.json()).deduped).toBe(false);

    const replay = await post(multipart(fields, '{"a":1}\n'));
    expect(replay.status).toBe(200);
    expect((await replay.json()).deduped).toBe(true);

    const rows = await getSeedDb()
      .select()
      .from(agentTranscriptChunks)
      .where(eq(agentTranscriptChunks.sessionId, sessionId));
    expect(rows).toHaveLength(1);
  });

  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post(multipart({ sessionId: "x", cursor: "0" }, "{}\n"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no chunk file (400)", async () => {
    const form = new FormData();
    form.set("sessionId", `sess-${randomUUID()}`);
    form.set("cursor", "0");
    const res = await appendTranscript(
      new NextRequest(ENDPOINT, { method: "POST", body: form })
    );
    expect(res.status).toBe(400);
  });
});
