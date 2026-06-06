// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server`
 * Purpose: Next.js-guarded re-export of server environment validation. Prevents client-bundle inclusion.
 * Scope: Adds "server-only" guard then re-exports everything from server-env.ts. Does not contain logic.
 * Invariants: All logic lives in server-env.ts; this file is only the guard.
 * Side-effects: none
 * Notes: Bootstrap/job code should import from server-env.ts directly to avoid the "server-only" guard.
 * Links: server-env.ts
 * @public
 */

import "server-only";

export * from "./server-env";
