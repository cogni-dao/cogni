// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/schedules.list.v1.contract`
 * Purpose: Defines operation contract for listing user schedules.
 * Scope: Provides Zod schema and types for schedule list wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Returns only schedules owned by the caller
 * Side-effects: none
 * Links: /api/v1/schedules route, https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @internal
 */

import { z } from "zod";

import { ScheduleResponseSchema } from "./schedules.create.v1.contract";

export const schedulesListOperation = {
  id: "schedules.list.v1",
  summary: "List user schedules",
  description: "Returns all schedules owned by the authenticated user.",
  input: z.object({}), // No input, GET request
  output: z.object({
    schedules: z.array(ScheduleResponseSchema),
  }),
} as const;

// Export inferred types
export type SchedulesListOutput = z.infer<typeof schedulesListOperation.output>;
