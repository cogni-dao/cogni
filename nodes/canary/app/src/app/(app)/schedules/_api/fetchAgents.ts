// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/_api/fetchAgents`
 * Purpose: Client-side fetch wrapper for agents list.
 * Scope: Calls /api/v1/ai/agents with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed AgentsOutput or throws
 * Side-effects: IO
 * Links: [ai.agents.v1.contract](../../../../contracts/ai.agents.v1.contract.ts)
 * @internal
 */

import type { AgentsOutput } from "@cogni/node-contracts";

export async function fetchAgents(): Promise<AgentsOutput> {
  const response = await fetch("/api/v1/ai/agents", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch agents",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
