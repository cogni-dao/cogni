// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/schedules.delete.v1.contract`
 * Purpose: Defines operation contract for deleting a schedule.
 * Scope: Provides Zod schema and types for schedule deletion wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - Deletion also revokes the associated grant
 *   - Returns 204 No Content on success
 * Side-effects: none
 * Links: /api/v1/schedules/[scheduleId] route, https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @internal
 */

import { z } from "zod";

export const schedulesDeleteOperation = {
  id: "schedules.delete.v1",
  summary: "Delete a schedule",
  description:
    "Deletes a schedule and revokes its associated execution grant. Returns empty response on success.",
  input: z.object({}), // No body, DELETE request with scheduleId in path
  output: z.object({}), // Empty response, 204 No Content
} as const;
