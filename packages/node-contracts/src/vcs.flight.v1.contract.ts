// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.flight.v1`
 * Purpose: Zod contract for POST /api/v1/vcs/flight — nodeRef candidate-a flight request.
 * Scope: Input/output shapes only. Does not make network calls or import GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.flight.v1.contract
 * Side-effects: none
 * Links: task.0370, nodes/operator/app/src/app/api/v1/vcs/flight/route.ts
 * @public
 */

import { z } from "zod";

const workflowRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?![0-9a-f]{40}$)(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))(?![./])(?!.*[./]$)[A-Za-z0-9][A-Za-z0-9._/-]*$/i,
    "workflowRef must be a same-repository branch or tag name"
  );

export const flightOperation = {
  input: z.object({
    nodeRef: z.object({
      nodeId: z.string().min(1).describe("Node UUID or unique slug"),
      sourceSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
    }),
    workflowRef: workflowRefSchema.optional(),
  }),

  output: z.object({
    dispatched: z.boolean(),
    slot: z.literal("candidate-a"),
    nodeRef: z.object({
      nodeId: z.string().uuid(),
      slug: z.string(),
      sourceSha: z.string(),
      sourceRepo: z.string().url(),
      image: z.string(),
    }),
    workflowUrl: z.string().url(),
    message: z.string(),
  }),
} as const;
