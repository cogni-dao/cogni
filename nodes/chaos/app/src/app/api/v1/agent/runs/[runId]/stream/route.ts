// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/runs/[runId]/stream`
 * Purpose: Agent-first URL surface for graph run SSE reconnection.
 * Scope: Preserves the public `/api/v1/agent/runs/{runId}/stream` URL
 *   documented in docs/guides/agent-api-validation.md while delegating
 *   the handler logic to the canonical `/api/v1/ai/runs/{runId}/stream`
 *   route. No behavioral difference — ai/runs/stream already accepts
 *   machine bearer tokens through the shared getSessionUser alias.
 * Invariants: Zero duplication of ai/runs/[runId]/stream/route.ts.
 * @public
 */
export { GET } from "@/app/api/v1/ai/runs/[runId]/stream/route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
