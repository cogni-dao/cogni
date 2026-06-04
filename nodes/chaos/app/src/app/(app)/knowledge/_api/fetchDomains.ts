// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchDomains`
 * Purpose: Client-side fetch wrapper for the registered domains list.
 * Scope: Cookie-session only. Does not contain business logic, caching, or render concerns.
 * Side-effects: IO (GET /api/v1/knowledge/domains)
 * @internal
 */

import type { DomainsListResponse } from "@cogni/node-contracts";

export async function fetchDomains(): Promise<DomainsListResponse> {
  const response = await fetch("/api/v1/knowledge/domains", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch domains",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<DomainsListResponse>;
}
