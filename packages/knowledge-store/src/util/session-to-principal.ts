// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/util/session-to-principal`
 * Purpose: Maps a SessionUser plus the auth path that resolved it to the Principal accepted by the contribution service.
 * Scope: Pure transformation; structural input type keeps this package independent of `@cogni/node-shared`. Does not call I/O or read env vars.
 * Invariants: KNOWLEDGE_LOOP_CLOSED_VIA_SIGNED_IN_USER (v0) — Bearer = agent (cannot merge); cookie-session = user (can merge).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/knowledge-recall-path, https://node-template.cognidao.org/knowledge/knowledge-branch-design
 * @public
 */

import type { Principal } from "../domain/contribution-schemas.js";

export interface SessionUserLike {
  id: string;
  walletAddress: string | null;
  displayName: string | null;
}

/**
 * Auth path that produced the SessionUser. Routes determine this by inspecting
 * the Authorization header: a `Bearer cogni_ag_sk_*` token → 'bearer'; absence
 * (NextAuth cookie path) → 'session'. The signal must come from the route, not
 * inferred from the user record, because a session-cookie user with no wallet
 * is still a trusted human (per v0).
 */
export type PrincipalAuthSource = "bearer" | "session";

export function sessionUserToPrincipal(
  u: SessionUserLike,
  source: PrincipalAuthSource
): Principal {
  if (source === "session") {
    return {
      id: u.id,
      kind: "user",
      role: "admin",
      ...(u.displayName ? { name: u.displayName } : {}),
    };
  }
  return {
    id: u.id,
    kind: "agent",
    ...(u.displayName ? { name: u.displayName } : {}),
  };
}
