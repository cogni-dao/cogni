// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/runs`
 * Purpose: Agent-first URL surface for listing graph runs.
 * Scope: Preserves the public `/api/v1/agent/runs` URL documented in
 *   docs/guides/agent-api-validation.md while delegating the handler logic
 *   to the canonical `/api/v1/ai/runs` route. There is no behavioral
 *   difference — since PR 845 made every `getSessionUser` import
 *   bearer-capable (via @/app/_lib/auth/session → resolveRequestIdentity),
 *   the ai/runs handler already accepts machine bearer tokens. This file
 *   exists solely to keep the agent-first URL contract stable.
 * Invariants: Zero duplication of ai/runs/route.ts. Any behavioral change
 *   must happen in ai/runs/route.ts and is inherited here automatically.
 * @public
 */
export { GET } from "@/app/api/v1/ai/runs/route";
export const dynamic = "force-dynamic";
