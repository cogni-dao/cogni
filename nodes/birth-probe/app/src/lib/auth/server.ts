// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@/lib/auth/server`
 * Purpose: Canonical server-side session helper for Auth4.
 * Scope: Server-only. Wraps NextAuth's getServerSession with invariant enforcement. Do not use on client.
 * Invariants: Returns null unless id is present. walletAddress may be null for OAuth-only users.
 * Side-effects: IO (NextAuth session retrieval)
 * Links: docs/spec/authentication.md
 * @public
 */

import type { SessionUser } from "@cogni/node-shared";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export async function getServerSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id;
  if (!id) return null;

  return {
    id,
    walletAddress: session?.user?.walletAddress ?? null,
    displayName: session?.user?.displayName ?? null,
    avatarColor: session?.user?.avatarColor ?? null,
  };
}
