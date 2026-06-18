// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/schedules.create.v1.contract`
 * Purpose: Defines operation contract for creating a schedule.
 * Scope: Provides Zod schema and types for schedule creation wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Exactly one of graphId xor route is set (graph run xor node-task dispatch)
 *   - route is node-relative — starts with a slash, no scheme, no protocol-relative, no traversal
 * Side-effects: none
 * Links: /api/v1/schedules route, docs/design/node-temporal-tenant-interface.md
 * @internal
 */

import { z } from "zod";

/**
 * Node-relative route guard for a NodeTask schedule (SSRF / cross-tenant defense).
 * Must start with a single "/", carry no scheme (":") , no protocol-relative ("//"),
 * and no path traversal ("..").
 */
const RouteSchema = z
  .string()
  .min(1)
  .refine(
    (r) =>
      r.startsWith("/") &&
      !r.startsWith("//") &&
      !r.includes(":") &&
      !r.includes(".."),
    {
      message:
        "route must be node-relative: start with '/', no scheme, no '//', no '..'",
    }
  );

/**
 * Schedule creation input schema. Exactly one of graphId (graph run) xor
 * route (NodeTask http-dispatch) is supplied.
 */
export const ScheduleCreateInputSchema = z
  .object({
    /** Graph ID in format provider:name (e.g., "langgraph:poet"). Mutually exclusive with route. */
    graphId: z.string().min(1).optional(),
    /** Node-relative route for a NodeTask http-dispatch schedule. Mutually exclusive with graphId. */
    route: RouteSchema.optional(),
    /** Graph input payload (messages, model, etc.) or NodeTask payload. */
    input: z.record(z.string(), z.unknown()),
    /** 5-field cron expression (e.g., "0 9 * * *" for 9am daily) */
    cron: z.string().min(1),
    /** IANA timezone (e.g., "UTC", "America/New_York") */
    timezone: z.string().min(1),
  })
  .refine((v) => (v.graphId === undefined) !== (v.route === undefined), {
    message: "Provide exactly one of graphId or route",
    path: ["graphId"],
  });

/**
 * Schedule response schema (returned after creation).
 */
export const ScheduleResponseSchema = z.object({
  id: z.string().uuid(),
  graphId: z.string(),
  input: z.record(z.string(), z.unknown()),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const schedulesCreateOperation = {
  id: "schedules.create.v1",
  summary: "Create a new schedule",
  description:
    "Creates a cron-based schedule for recurring graph execution. Returns the created schedule with next run time.",
  input: ScheduleCreateInputSchema,
  output: ScheduleResponseSchema,
} as const;

// Export inferred types - all consumers MUST use these, never manual interfaces
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;
