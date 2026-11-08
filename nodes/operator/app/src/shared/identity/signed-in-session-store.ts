// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/identity/signed-in-session-store`
 * Purpose: Carries "a valid session already exists on this OAuth callback request" from the
 *   NextAuth route handler to the `signIn` callback in `src/auth.ts`.
 * Scope: Request-scoped AsyncLocalStorage only. Does not read cookies, touch the DB, or decide policy.
 * Invariants:
 *   - SESSION_NEVER_SWITCHED_BY_OAUTH_CALLBACK: an OAuth callback that arrives while a session
 *     exists, and carries no verified link intent, must never sign in as another user (bug.5603).
 *   - Populated on callback routes only. `null` means the request is signed out.
 * Side-effects: none
 * Links: src/auth.ts, src/app/api/auth/[...nextauth]/route.ts, bug.5603
 * @public
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The user a valid session cookie already belongs to when the OAuth callback arrived. */
export interface SignedInSession {
  userId: string;
}

export const signedInSessionStore =
  new AsyncLocalStorage<SignedInSession | null>();
