// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchKnowledgeEntry`
 * Purpose: Client-side fetch wrapper for a single knowledge entry (the permalink page).
 * Scope: Calls GET /api/v1/knowledge/[id] with same-origin credentials. Returns typed row or throws.
 * Invariants: Browser client — same-origin cookie credentials, never a Bearer header. The endpoint itself accepts any principal (KNOWLEDGE_READ_REQUIRES_PRINCIPAL); this UI path is cookie-only by construction.
 * Side-effects: IO
 * @internal
 */

import type { KnowledgeRow } from "@cogni/node-contracts";

export async function fetchKnowledgeEntry(id: string): Promise<KnowledgeRow> {
  const response = await fetch(`/api/v1/knowledge/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch knowledge entry",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<KnowledgeRow>;
}
