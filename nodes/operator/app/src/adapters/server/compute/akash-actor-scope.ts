// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: @adapters/server/compute/akash-actor-scope
 * Purpose: Check the current source-owned operation before and after each await.
 * Scope: Internal concrete adapters only; no SQL or transport capability is exported.
 * Invariants: Async descendants retain revocation; cleanup does not renew application authority.
 * Side-effects: Async context only
 * Links: subtask.5033; paid-allocation-admission F1 seq5
 * @internal
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AkashTxError } from "@/ports";

const scope = new AsyncLocalStorage<{
  check: () => void;
  callbacks: Set<Promise<void>>;
}>();

export function checkActorDatabaseScope(deadlineAt?: number): void {
  scope.getStore()?.check();
  if (deadlineAt !== undefined && Date.now() >= deadlineAt)
    throw new AkashTxError(
      "outcome_unknown",
      "HELD: database acknowledgement unavailable; retain allocation custody"
    );
}

/** Only the local owner enters a scope. Concrete operations return materialized results. */
export function inActorDatabaseScope<T>(
  check: () => void,
  callbacks: Set<Promise<void>>,
  operation: () => Promise<T>
): Promise<T> {
  return scope.run({ check, callbacks }, operation);
}

/** postgres.begin may reject on close before its source callback has returned. */
export function trackActorDatabaseCallback<T>(
  operation: () => Promise<T>
): Promise<T> {
  checkActorDatabaseScope();
  const result = actorDatabaseAwait(operation);
  const callbacks = scope.getStore()?.callbacks;
  if (callbacks) {
    const completed = result.then(
      () => undefined,
      () => undefined
    );
    callbacks.add(completed);
    void completed.then(() => callbacks.delete(completed));
  }
  return result;
}

/** Construct/materialize the typed query only after checking its original generation. */
export async function actorDatabaseAwait<T>(
  operation: () => T | PromiseLike<T>,
  deadlineAt?: number
): Promise<T> {
  checkActorDatabaseScope(deadlineAt);
  try {
    return await operation();
  } finally {
    checkActorDatabaseScope(deadlineAt);
  }
}
