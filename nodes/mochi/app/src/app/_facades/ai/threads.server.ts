// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/ai/threads.server`
 * Purpose: App-layer facade for thread list/load/delete operations.
 * Scope: Resolves session user to thread persistence port, returns contract-typed output. Does not handle HTTP transport.
 * Invariants:
 *   - Only app layer imports this; routes call this, not features/* directly
 *   - TENANT_SCOPED: All operations scoped to authenticated user via RLS
 * Side-effects: IO (via ThreadPersistencePort)
 * Links: src/ports/thread-persistence.port.ts, src/contracts/ai.threads.v1.contract.ts
 * @public
 */

import { toUserId } from "@cogni/ids";
import type {
  listThreadsOperation,
  loadThreadOperation,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import type { z } from "zod";
import { getContainer } from "@/bootstrap/container";

type ListThreadsInput = {
  sessionUser: SessionUser;
  limit?: number;
  offset?: number;
};

type ListThreadsOutput = z.infer<typeof listThreadsOperation.output>;

export async function listThreadsFacade(
  input: ListThreadsInput
): Promise<ListThreadsOutput> {
  const userId = toUserId(input.sessionUser.id);
  const port = getContainer().threadPersistenceForUser(userId);
  const opts: { limit?: number; offset?: number } = {};
  if (input.limit !== undefined) opts.limit = input.limit;
  if (input.offset !== undefined) opts.offset = input.offset;
  const threads = await port.listThreads(input.sessionUser.id, opts);
  return {
    threads: threads.map((t) => ({
      stateKey: t.stateKey,
      title: t.title,
      updatedAt: t.updatedAt.toISOString(),
      messageCount: t.messageCount,
      metadata: t.metadata,
    })),
  };
}

type LoadThreadInput = {
  sessionUser: SessionUser;
  stateKey: string;
};

type LoadThreadOutput = z.infer<typeof loadThreadOperation.output>;

export async function loadThreadFacade(
  input: LoadThreadInput
): Promise<LoadThreadOutput> {
  const userId = toUserId(input.sessionUser.id);
  const port = getContainer().threadPersistenceForUser(userId);
  const messages = await port.loadThread(input.sessionUser.id, input.stateKey);
  return {
    stateKey: input.stateKey,
    messages,
  };
}

type DeleteThreadInput = {
  sessionUser: SessionUser;
  stateKey: string;
};

export async function deleteThreadFacade(
  input: DeleteThreadInput
): Promise<{ ok: true }> {
  const userId = toUserId(input.sessionUser.id);
  const port = getContainer().threadPersistenceForUser(userId);
  await port.softDelete(input.sessionUser.id, input.stateKey);
  return { ok: true };
}
