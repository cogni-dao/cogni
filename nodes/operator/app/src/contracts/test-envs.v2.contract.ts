// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/test-envs.v2`
 * Purpose: Wire contract for `/api/v2/test-envs` (story.5159, `work/designs/test-env-v2.md`): a dev asks for
 *   their own candidate-a copy of a node's `app` at one SHA and reads when it is ready, without waiting in a
 *   queue behind, or superseding, another lane.
 * Scope: Request/response schemas only. The route records a release under the test env's own workload key; the
 *   node-deploy sequencer executes it.
 * Invariants:
 *   - INTENT_ONLY: a 202 means "a release and its desired row were written", never "ready". Ready is
 *     `state: "ready"`, which is the sequencer's proven `active` attempt, not a `/version` probe.
 *   - FULL_SHA: `sourceSha` is a full 40-hex git sha.
 *   - STRICT_INPUT: unknown keys are a 400.
 *   - ID_IS_THE_KEY: `testEnvId` is the workload key `te<6 letters>`; it carries no node, so a read resolves the
 *     node from the one desired row of that key and authorizes against it.
 *   - REQUEST_TO_READY: `readyMs` = `readyAt - requestedAt` (the release row's `createdAt` to its first
 *     activation), the number `deploy.lead-time@1` with `testEnvs: "only"` aggregates.
 * Side-effects: none (schemas only)
 * Links: features/node-deploy/test-env.ts, app/api/v2/test-envs/route.ts
 * @public
 */

import { z } from "zod";

export const TestEnvIdSchema = z
  .string()
  .regex(/^te[a-z]{6}$/, "expected a test env id");

export const TEST_ENV_STATES = [
  "requested",
  "deploying",
  "ready",
  "failed",
  "closing",
  "closed",
] as const;
export const TestEnvStateSchema = z.enum(TEST_ENV_STATES);

export const TestEnvCreateInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex sha"),
  label: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "expected a short lowercase label")
    .optional(),
});

export const TestEnvCreatedSchema = z.object({
  testEnvId: TestEnvIdSchema,
  host: z.string().min(1),
  state: TestEnvStateSchema,
});

export const TestEnvReadSchema = z.object({
  testEnvId: TestEnvIdSchema,
  nodeId: z.string().uuid(),
  sourceSha: z.string(),
  host: z.string().nullable(),
  label: z.string().nullable(),
  state: TestEnvStateSchema,
  requestedAt: z.string().nullable(),
  readyAt: z.string().nullable(),
  readyMs: z.number().nullable(),
  expiresAt: z.string().nullable(),
});

export type TestEnvCreateInput = z.infer<typeof TestEnvCreateInputSchema>;
export type TestEnvCreated = z.infer<typeof TestEnvCreatedSchema>;
export type TestEnvRead = z.infer<typeof TestEnvReadSchema>;
