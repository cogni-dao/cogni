// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/governance-schedules-sync.internal.v1.contract`
 * Purpose: Contract for internal governance schedule sync trigger endpoint.
 * Scope: Defines response shape for POST /api/internal/ops/governance/schedules/sync. Does not contain business logic.
 * Invariants:
 *   - Internal endpoint only
 *   - Bearer token auth required (INTERNAL_OPS_TOKEN)
 *   - Response shape remains stable
 * Side-effects: none
 * Links: /api/internal/ops/governance/schedules/sync route, https://node-template.cognidao.org/knowledge/governance-schedule-sync
 * @internal
 */

import { z } from "zod";

export const GovernanceSchedulesSyncSummarySchema = z.object({
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  resumed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  paused: z.number().int().min(0),
});

export const governanceSchedulesSyncOperation = {
  id: "governance.schedules.sync.internal.v1",
  summary: "Sync governance schedules via internal ops endpoint",
  description:
    "Internal deploy-time endpoint that runs governance schedule sync with system principal grant enforcement.",
  input: z.object({}).strict(),
  output: GovernanceSchedulesSyncSummarySchema,
} as const;

export type GovernanceSchedulesSyncSummary = z.infer<
  typeof GovernanceSchedulesSyncSummarySchema
>;
