// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/schedules.update.v1.contract`
 * Purpose: Defines operation contract for updating a schedule.
 * Scope: Provides Zod schema and types for schedule update wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - All fields optional (partial update)
 * Side-effects: none
 * Links: /api/v1/schedules/[scheduleId] route, https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @internal
 */

import { z } from "zod";

import { ScheduleResponseSchema } from "./schedules.create.v1.contract";

/**
 * Schedule update input schema.
 * All fields optional for partial updates.
 */
export const ScheduleUpdateInputSchema = z.object({
  /** Graph input payload (messages, model, etc.) */
  input: z.record(z.string(), z.unknown()).optional(),
  /** 5-field cron expression */
  cron: z.string().min(1).optional(),
  /** IANA timezone */
  timezone: z.string().min(1).optional(),
  /** Enable/disable toggle */
  enabled: z.boolean().optional(),
});

export const schedulesUpdateOperation = {
  id: "schedules.update.v1",
  summary: "Update a schedule",
  description:
    "Updates an existing schedule. Only provided fields are changed. Returns the updated schedule.",
  input: ScheduleUpdateInputSchema,
  output: ScheduleResponseSchema,
} as const;

// Export inferred types
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateInputSchema>;
