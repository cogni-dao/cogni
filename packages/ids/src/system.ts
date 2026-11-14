// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ids/system`
 * Purpose: System actor constant for worker/service operations. Import-gated sub-path.
 * Scope: SYSTEM_ACTOR only. Must NOT be imported from user-facing request paths.
 * Invariants:
 * - Only worker services, scheduler activities, and bootstrap/container may import this
 * - User-facing routes import from @cogni/ids (root) which does NOT export SYSTEM_ACTOR
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/rls-tenant-isolation
 * @public
 */

import type { ActorId } from "./index";

/**
 * System actor constant for worker/service operations (scheduler, settlement).
 * Deterministic UUID so SET LOCAL is valid and audit logs are traceable.
 */
export const SYSTEM_ACTOR: ActorId =
  "00000000-0000-4000-a000-000000000000" as ActorId;
