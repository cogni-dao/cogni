// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ids`
 * Purpose: Branded ID types for compile-time RLS enforcement across the monorepo.
 * Scope: Type definitions and boundary constructors only. Does not export SYSTEM_ACTOR (lives in @cogni/ids/system sub-path).
 * Invariants:
 * - toUserId() is the single entry point for creating a UserId (validated UUID v4)
 * - userActor() is the only way to create an ActorId from a UserId
 * - User-facing ports accept UserId only — SYSTEM_ACTOR (ActorId) is rejected at compile time
 * - Worker-facing ports accept ActorId
 * - SYSTEM_ACTOR lives in @cogni/ids/system (import-gated for worker/service code only)
 * - Only edge code (HTTP handlers, env parsing, test fixtures) should call toUserId()
 * - No `as UserId` / `as ActorId` casts outside test fixtures — enforced by PR review
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/rls-tenant-isolation
 * @public
 */

import type { Tagged } from "type-fest";

/** UUID v4 format regex — single source of truth for ID validation. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Branded user identity — validated UUID v4. Used by user-facing ports. */
export type UserId = Tagged<string, "UserId">;

/** Branded actor identity — who is performing this operation. Used by worker ports and withTenantScope. */
export type ActorId = Tagged<string, "ActorId">;

/** Validate and brand a raw string as UserId. Boundary constructor — call at edges only. */
export function toUserId(raw: string): UserId {
  if (!UUID_RE.test(raw)) {
    throw new Error(`Invalid UserId (expected UUID v4): ${raw}`);
  }
  return raw as UserId;
}

/** Convert a UserId to an ActorId for RLS scoping (no re-parse, already validated). */
export function userActor(userId: UserId): ActorId {
  return userId as unknown as ActorId;
}
