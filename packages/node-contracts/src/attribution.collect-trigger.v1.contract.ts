// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.collect-trigger.v1.contract`
 * Purpose: Contract for user-facing epoch collection trigger endpoint.
 * Scope: Defines response shape for POST /api/v1/attribution/collect. Does not contain business logic.
 * Invariants:
 *   - Session auth required (any logged-in user)
 *   - Response shape remains stable
 * Side-effects: none
 * Links: /api/v1/attribution/collect route, https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const CollectTriggerResponseSchema = z.object({
  triggered: z.boolean(),
  scheduleId: z.string(),
});

export const CollectTriggerCooldownResponseSchema = z.object({
  error: z.literal("cooldown"),
  retryAfterSeconds: z.number().int().min(0),
  lastRunAt: z.string().nullable(),
});

export const collectTriggerOperation = {
  id: "attribution.collect-trigger.v1",
  summary: "Trigger epoch collection on demand",
  description:
    "User-facing endpoint that triggers the LEDGER_INGEST schedule immediately via Temporal ScheduleHandle.trigger().",
  input: z.object({}).strict(),
  output: CollectTriggerResponseSchema,
} as const;

export type CollectTriggerResponse = z.infer<
  typeof CollectTriggerResponseSchema
>;

export type CollectTriggerCooldownResponse = z.infer<
  typeof CollectTriggerCooldownResponseSchema
>;
