// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/thread-persistence.stack`
 * Purpose: Acceptance checks for thread persistence spec (§ Acceptance Checks 1–8).
 * Scope: Tests route round-trip, adapter-level concurrency, tenant isolation, and mapper reconstruction. Does not test PII masking internals.
 * Invariants:
 *   - MULTI_TURN_PERSISTENCE: Turn 2 loads turn 1 from DB, not client payload
 *   - SERVER_OWNS_MESSAGES: Client sends single message string; server builds authoritative thread
 *   - TENANT_ISOLATION: User A cannot see user B's threads via RLS
 *   - OPTIMISTIC_APPEND: saveThread rejects on expectedMessageCount mismatch
 *   - MAX_THREAD_MESSAGES: saveThread rejects when exceeding 200 messages
 * Side-effects: IO (database writes, HTTP requests via route handler)
 * Links: docs/spec/thread-persistence.md, src/app/api/v1/ai/chat/route.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { toUserId } from "@cogni/ids";
import type { SessionUser } from "@cogni/node-shared";
import { createChatRequest } from "@tests/_fakes";
import { seedAuthenticatedUser } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  isFinishEvent,
  readSseEvents,
  type SseEvent,
} from "@tests/helpers/data-stream";
import type { UIMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { MAX_THREAD_MESSAGES } from "@/adapters/server/ai/thread-persistence.adapter";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as chatPOST } from "@/app/api/v1/ai/chat/route";
import { GET as modelsGET } from "@/app/api/v1/ai/models/route";
import { getContainer } from "@/bootstrap/container";
import { ThreadConflictError } from "@/ports";
import { aiThreads } from "@/shared/db/schema";

// Mock session — stack tests seed a real user then mock getSessionUser
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

/** Drain the SSE stream response, collecting events until finish. */
async function drainStream(res: Response) {
  const events: SseEvent[] = [];
  const start = Date.now();
  for await (const e of readSseEvents(res)) {
    events.push(e);
    if (isFinishEvent(e)) break;
    if (Date.now() - start > 30_000) throw new Error("Stream timeout 30s");
  }
  return events;
}

/**
 * Poll DB until a condition is met. Phase 2 persist runs async inside
 * createUIMessageStream — there's a race between stream drain
 * and server-side persist.
 */
async function pollUntil<T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  { timeoutMs = 5000, intervalMs = 100 } = {}
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (check(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn(); // final attempt — let assertion fail naturally
}

/** Helper: build a minimal UIMessage for adapter-level tests. */
function makeUIMessage(role: "user" | "assistant", text: string): UIMessage {
  return {
    id: randomUUID(),
    role,
    parts: [{ type: "text" as const, text }],
  };
}

describe("Thread Persistence", () => {
  // ──────────────────────────────────────────────────────
  // Check 1 + 2: Multi-turn persistence + Server owns messages
  // ──────────────────────────────────────────────────────
  it("persists multi-turn conversation and loads from DB on turn 2", async () => {
    const db = getSeedDb();
    const { user } = await seedAuthenticatedUser(
      db,
      { id: randomUUID() },
      { balanceCredits: 100_000_000 }
    );
    if (!user.walletAddress) throw new Error("walletAddress required");

    const sessionUser: SessionUser = {
      id: user.id,
      walletAddress: user.walletAddress,
    };
    vi.mocked(getSessionUser).mockResolvedValue(sessionUser);

    const modelsRes = await modelsGET(
      new NextRequest("http://localhost:3000/api/v1/ai/models")
    );
    expect(modelsRes.status).toBe(200);
    const { defaultRef } = await modelsRes.json();

    // --- Turn 1 ---
    const stateKey = `test-thread-${randomUUID().slice(0, 8)}`;
    const turn1Req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createChatRequest({
          message: "Say exactly: TURN1_OK",
          modelRef: defaultRef,
          stateKey,
        })
      ),
    });

    const turn1Res = await chatPOST(turn1Req);
    expect(turn1Res.status).toBe(200);
    expect(turn1Res.headers.get("X-State-Key")).toBe(stateKey);
    await drainStream(turn1Res);

    // Poll for phase 2 persist
    const queryThread = () =>
      db
        .select()
        .from(aiThreads)
        .where(
          and(
            eq(aiThreads.ownerUserId, user.id),
            eq(aiThreads.stateKey, stateKey)
          )
        );
    const rows = await pollUntil(queryThread, (r) => {
      const msgs = (r[0]?.messages ?? []) as Array<{ role: string }>;
      return msgs.length >= 2;
    });
    expect(rows).toHaveLength(1);
    const messages = rows[0]?.messages as Array<{ role: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[messages.length - 1]?.role).toBe("assistant");

    // --- Turn 2: SERVER_OWNS_MESSAGES — server loads turn 1 from DB ---
    // P1 contract: client sends only { message: string }, not messages[]
    // Server appends to authoritative thread from DB
    const turn2Req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createChatRequest({
          message: "Say exactly: TURN2_OK",
          modelRef: defaultRef,
          stateKey,
        })
      ),
    });

    const turn2Res = await chatPOST(turn2Req);
    expect(turn2Res.status).toBe(200);
    await drainStream(turn2Res);

    const rows2 = await pollUntil(queryThread, (r) => {
      const msgs = (r[0]?.messages ?? []) as Array<{ role: string }>;
      return msgs.length >= 4;
    });
    expect(rows2).toHaveLength(1);
    const messages2 = rows2[0]?.messages as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(messages2).toHaveLength(4);
    expect(messages2.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    // Turn 2 user message should be exactly what we sent
    const turn2UserMsg = messages2[2] as (typeof messages2)[number];
    const turn2Text = turn2UserMsg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(turn2Text).toContain("TURN2_OK");
  });

  // ──────────────────────────────────────────────────────
  // Check 3: Tool persistence (stub — no reliable tool-calling mock LLM)
  // ──────────────────────────────────────────────────────
  it.skip("persists tool call parts in assistant UIMessage (requires tool-calling graph)", async () => {
    // When a graph emits tool_call_start + tool_call_result events,
    // the route accumulator should build DynamicToolUIParts in the
    // assistant UIMessage. After persist, the ai_threads row should
    // contain parts with:
    //   { type: "dynamic-tool", toolCallId, toolName, state: "output-available", input, output }
    //
    // Unblock: mock-llm needs a mode that returns tool_use content blocks,
    // or use a real tool-calling graph (sandbox:openclaw) in test mode.
  });

  // ──────────────────────────────────────────────────────
  // Check 5: Tenant isolation (RLS + owner scoping)
  // ──────────────────────────────────────────────────────
  describe("Tenant Isolation", () => {
    it("user A cannot load user B's thread via adapter (RLS enforced)", async () => {
      const db = getSeedDb();
      const { user: userA } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });
      const { user: userB } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });

      const sharedStateKey = `shared-${randomUUID().slice(0, 8)}`;
      const container = getContainer();
      const adapterA = container.threadPersistenceForUser(toUserId(userA.id));
      const adapterB = container.threadPersistenceForUser(toUserId(userB.id));

      // User A saves a thread
      await adapterA.saveThread(
        userA.id,
        sharedStateKey,
        [makeUIMessage("user", "secret from A")],
        0
      );

      // User A can load it
      const loadedByA = await adapterA.loadThread(userA.id, sharedStateKey);
      expect(loadedByA).toHaveLength(1);

      // User B cannot load it — RLS blocks
      const loadedByB = await adapterB.loadThread(userB.id, sharedStateKey);
      expect(loadedByB).toHaveLength(0);
    });

    it("two users with same stateKey have independent threads", async () => {
      const db = getSeedDb();
      const { user: userA } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });
      const { user: userB } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });

      const sharedKey = `shared-${randomUUID().slice(0, 8)}`;
      const container = getContainer();
      const adapterA = container.threadPersistenceForUser(toUserId(userA.id));
      const adapterB = container.threadPersistenceForUser(toUserId(userB.id));

      // Both save to same stateKey — no conflict
      await adapterA.saveThread(
        userA.id,
        sharedKey,
        [makeUIMessage("user", "message from A")],
        0
      );
      await adapterB.saveThread(
        userB.id,
        sharedKey,
        [makeUIMessage("user", "message from B")],
        0
      );

      // Each sees only their own data
      const threadA = await adapterA.loadThread(userA.id, sharedKey);
      const threadB = await adapterB.loadThread(userB.id, sharedKey);
      expect(threadA).toHaveLength(1);
      expect(threadB).toHaveLength(1);
      expect((threadA[0] as UIMessage).parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "message from A" }),
        ])
      );
      expect((threadB[0] as UIMessage).parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "message from B" }),
        ])
      );

      // Verify two distinct rows in DB
      const rows = await db
        .select()
        .from(aiThreads)
        .where(eq(aiThreads.stateKey, sharedKey));
      expect(rows).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────────────
  // Check 7: Messages grow only (optimistic concurrency)
  // ──────────────────────────────────────────────────────
  describe("Optimistic Concurrency", () => {
    it("saveThread rejects when expectedMessageCount mismatches stored count", async () => {
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });

      const stateKey = `occ-${randomUUID().slice(0, 8)}`;
      const adapter = getContainer().threadPersistenceForUser(
        toUserId(user.id)
      );

      // Save initial thread with 1 message
      await adapter.saveThread(
        user.id,
        stateKey,
        [makeUIMessage("user", "msg 1")],
        0
      );

      // Stale save: claims expected=0 but stored has 1 → conflict
      await expect(
        adapter.saveThread(
          user.id,
          stateKey,
          [makeUIMessage("user", "msg 1"), makeUIMessage("assistant", "rsp")],
          0
        )
      ).rejects.toThrow(ThreadConflictError);

      // Correct save: expected=1 matches stored count → succeeds
      await adapter.saveThread(
        user.id,
        stateKey,
        [makeUIMessage("user", "msg 1"), makeUIMessage("assistant", "rsp")],
        1
      );

      const loaded = await adapter.loadThread(user.id, stateKey);
      expect(loaded).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────────────
  // Check 8: Thread message limit (MAX_THREAD_MESSAGES)
  // ──────────────────────────────────────────────────────
  describe("Thread Message Limit", () => {
    it(`saveThread rejects when exceeding MAX_THREAD_MESSAGES (${MAX_THREAD_MESSAGES})`, async () => {
      const db = getSeedDb();
      const { user } = await seedAuthenticatedUser(db, {
        id: randomUUID(),
      });

      const stateKey = `limit-${randomUUID().slice(0, 8)}`;
      const adapter = getContainer().threadPersistenceForUser(
        toUserId(user.id)
      );

      // Build array exceeding limit
      const tooMany: UIMessage[] = Array.from(
        { length: MAX_THREAD_MESSAGES + 1 },
        (_, i) => makeUIMessage(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)
      );

      await expect(
        adapter.saveThread(user.id, stateKey, tooMany, 0)
      ).rejects.toThrow(/MAX_THREAD_MESSAGES/);
    });
  });
});
