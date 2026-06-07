// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.flight.v1`
 * Purpose: Zod contract for POST /api/v1/vcs/flight — CI-gated candidate-a flight request.
 * Scope: Input/output shapes only. Does not make network calls or import GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.flight.v1.contract
 * Side-effects: none
 * Links: task.0370, nodes/operator/app/src/app/api/v1/vcs/flight/route.ts
 * @public
 */

import { z } from "zod";

export const flightOperation = {
  input: z
    .object({
      prNumber: z.number().int().positive().optional(),
      nodeRef: z
        .object({
          nodeId: z.string().uuid(),
          sourceSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
        })
        .optional(),
    })
    .refine((input) => Boolean(input.prNumber) !== Boolean(input.nodeRef), {
      message: "Provide exactly one of prNumber or nodeRef",
    }),

  output: z.object({
    dispatched: z.boolean(),
    slot: z.literal("candidate-a"),
    prNumber: z.number().int().positive().optional(),
    headSha: z.string().nullable().optional(),
    nodeRef: z
      .object({
        nodeId: z.string().uuid(),
        slug: z.string(),
        sourceSha: z.string(),
        sourceRepo: z.string().url(),
        image: z.string(),
      })
      .optional(),
    workflowUrl: z.string().url(),
    message: z.string(),
  }),
} as const;
