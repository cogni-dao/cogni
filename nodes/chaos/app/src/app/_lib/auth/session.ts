// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/session`
 * Purpose: Default session resolver — agent-first (Bearer token → session cookie fallback).
 * Scope: Re-exports resolveRequestIdentity as getSessionUser so all routes using this import
 *   accept both machine bearer tokens and human session cookies without per-route changes.
 * Invariants:
 *   - Bearer checked first; same-origin session fallback for browser requests.
 *   - request-identity.ts MUST NOT import from this module — it breaks the import cycle by
 *     calling @/lib/auth/server.getServerSessionUser directly. Enforced by eye for now; a
 *     depcruise rule can codify it later.
 * Side-effects: IO (NextAuth session retrieval on cookie path)
 * Notes: Routes that must remain session-only (governance, user profile) import
 *   getServerSessionUser from @/lib/auth/server directly instead of using this export.
 * Links: docs/spec/security-auth.md, request-identity.ts
 * @public
 */
export { resolveRequestIdentity as getSessionUser } from "@/app/_lib/auth/request-identity";
