// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/createDomain`
 * Purpose: Client-side POST wrapper to register a new knowledge domain via the operator API.
 * Scope: Cookie-session only. Does not contain UI state, optimistic-update logic, or query-cache wiring.
 * Side-effects: IO; INSERT INTO domains + dolt_commit on candidate-a.
 * @internal
 */

import type {
  DomainsCreateRequest,
  DomainsCreateResponse,
} from "@cogni/node-contracts";

export async function createDomain(
  input: DomainsCreateRequest
): Promise<DomainsCreateResponse> {
  const response = await fetch("/api/v1/knowledge/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to register domain",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<DomainsCreateResponse>;
}
