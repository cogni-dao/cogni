// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/auth/link-intent-store`
 * Purpose: AsyncLocalStorage for passing link intent from route handler to NextAuth signIn callback.
 * Scope: Shared primitive. Only imports node:async_hooks. Does not depend on framework, IO, or route modules.
 * Invariants: Request-scoped via AsyncLocalStorage. Requires Node.js runtime (not Edge).
 *   Discriminated union: pending intent carries txId for DB verification, failed intent carries rejection reason.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/authentication-session-bearer
 * @public
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Raw decoded intent from JWT cookie — needs DB verification in signIn callback. */
export interface PendingLinkIntent {
  txId: string;
  userId: string;
}

/** Link flow was initiated but verification failed — must reject, never fall through. */
export interface FailedLinkIntent {
  failed: true;
  reason: string;
}

export type LinkIntent = PendingLinkIntent | FailedLinkIntent;

export function isPendingIntent(
  intent: LinkIntent | null | undefined
): intent is PendingLinkIntent {
  return intent != null && !("failed" in intent) && "txId" in intent;
}

export function isFailedIntent(
  intent: LinkIntent | null | undefined
): intent is FailedLinkIntent {
  return intent != null && "failed" in intent && intent.failed === true;
}

export const linkIntentStore = new AsyncLocalStorage<LinkIntent | null>();
