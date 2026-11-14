// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/governance.status.v1.contract`
 * Purpose: Contract for governance status endpoint showing system tenant health.
 * Scope: User-facing DAO transparency - credit balance, next run, recent runs. Read-only, authenticated users. Does not include governance control or configuration APIs.
 * Invariants:
 * - systemCredits returned as string (BigInt serialization)
 * - recentRuns limited to 10 (no pagination MVP)
 * - All timestamps ISO 8601 format
 * Side-effects: none
 * Notes: System tenant scope only (COGNI_SYSTEM_PRINCIPAL_USER_ID). No userId parameter.
 * Links: /api/v1/governance/status endpoint, https://node-template.cognidao.org/knowledge/governance-status-api spec
 * @public
 */

import { z } from "zod";

export const governanceStatusOutputSchema = z.object({
  systemCredits: z
    .string()
    .describe("System tenant balance (BigInt as string)"),
  upcomingRuns: z
    .array(
      z.object({
        name: z.string().describe("Schedule display name (e.g. 'Community')"),
        nextRunAt: z
          .string()
          .datetime()
          .describe("Next occurrence computed live from cron (always future)"),
      })
    )
    .describe("Next scheduled governance runs sorted by soonest first"),
  recentRuns: z.array(
    z.object({
      id: z.string().describe("Thread state key"),
      title: z.string().nullable().describe("Run title from metadata"),
      startedAt: z.string().datetime(),
      lastActivity: z.string().datetime(),
    })
  ),
});

// Protocol-neutral operation metadata.
export const governanceStatusOperation = {
  id: "governance.status.v1",
  summary: "Get system tenant governance status",
  description:
    "Returns governance health: system credit balance, next scheduled run, and recent execution history. Read-only transparency for DAO members.",
  input: z.object({}),
  output: governanceStatusOutputSchema,
} as const;
