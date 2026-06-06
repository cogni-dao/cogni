// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchKnowledge`
 * Purpose: Client-side fetch wrapper for the knowledge browse list.
 * Scope: Calls GET /api/v1/knowledge with same-origin credentials. Returns typed response or throws.
 * Invariants: Cookie-session only — never sends a Bearer header (per KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION).
 * Side-effects: IO
 * @internal
 */

import type { KnowledgeListResponse } from "@cogni/node-contracts";

export async function fetchKnowledge(): Promise<KnowledgeListResponse> {
  const response = await fetch("/api/v1/knowledge?limit=500", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch knowledge",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<KnowledgeListResponse>;
}
