// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/services/get-governance-status`
 * Purpose: Feature service orchestrating AccountService + GovernanceStatusPort for DAO transparency dashboard.
 * Scope: Reads system tenant balance and governance run data via ports. Does not access database directly or handle HTTP concerns.
 * Invariants:
 * - HEXAGONAL_ARCHITECTURE: Calls ports only, never imports adapters
 * - BIGINT_SERIALIZATION: Balance converted to string for JSON compatibility
 * - FEATURE_SERVICE_LAYER: Route delegates here, never queries DB directly
 * Side-effects: IO (reads via ports)
 * Links: docs/spec/governance-status-api.md, src/ports/governance-status.port.ts
 * @public
 */

import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import type { AccountService, GovernanceStatusPort } from "@/ports";

export interface GovernanceStatusResult {
  systemCredits: string;
  upcomingRuns: Array<{ name: string; nextRunAt: string }>;
  recentRuns: Array<{
    id: string;
    title: string | null;
    startedAt: string;
    lastActivity: string;
  }>;
}

export async function getGovernanceStatus(params: {
  accountService: AccountService;
  governanceStatusPort: GovernanceStatusPort;
}): Promise<GovernanceStatusResult> {
  const { accountService, governanceStatusPort } = params;

  const [balance, upcomingRuns, recentRuns] = await Promise.all([
    accountService.getBalance(COGNI_SYSTEM_BILLING_ACCOUNT_ID),
    governanceStatusPort.getUpcomingRuns({ limit: 3 }),
    governanceStatusPort.getRecentRuns({ limit: 10 }),
  ]);

  return {
    systemCredits: balance.toString(),
    upcomingRuns: upcomingRuns.map((r) => ({
      name: r.name,
      nextRunAt: r.nextRunAt.toISOString(),
    })),
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      title: run.title,
      startedAt: run.startedAt.toISOString(),
      lastActivity: run.lastActivity.toISOString(),
    })),
  };
}
