// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.flight.v1`
 * Purpose: Zod contract for POST /api/v1/vcs/flight — candidate-a flight request.
 *   Two flight shapes, both dispatching `candidate-flight.yml` on the operator's parent repo:
 *     - `nodeRef`: externally-built child-node artifact row (slug + sourceSha).
 *     - `codePr`:  an operator-MONOREPO PR, by `prNumber` — the code-PR path that lets an external
 *       agent (read-only on GitHub) flight its own monorepo PR without a maintainer `gh workflow run`.
 * Scope: Input/output shapes only. Does not make network calls or import GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.flight.v1.contract
 *   - EXACTLY_ONE_TARGET: input is a discriminated union — `nodeRef` XOR `codePr`, never both,
 *     never neither (Zod union rejects the empty / ambiguous body).
 *   - NO_REPO_FROM_AGENT: owner/repo for the `codePr` path are operator-resolved from env, never the
 *     request body (anti-spoof). The agent supplies only the PR number on the operator's own monorepo.
 * Side-effects: none
 * Links: task.0370, nodes/operator/app/src/app/api/v1/vcs/flight/route.ts
 * @public
 */

import { z } from "zod";

const nodeRefInput = z.object({
  nodeRef: z.object({
    nodeId: z.string().uuid(),
    sourceSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
  }),
});

const codePrInput = z.object({
  /** Operator-monorepo PR number to flight. owner/repo are env-resolved, never the body. */
  codePr: z.object({
    prNumber: z.number().int().positive(),
  }),
});

export const flightOperation = {
  input: z.union([nodeRefInput, codePrInput]),

  output: z.object({
    dispatched: z.boolean(),
    slot: z.literal("candidate-a"),
    /** Present for a `nodeRef` flight; absent for a `codePr` flight. */
    nodeRef: z
      .object({
        nodeId: z.string().uuid(),
        slug: z.string(),
        sourceSha: z.string(),
        sourceRepo: z.string().url(),
        image: z.string(),
      })
      .optional(),
    /** Present for a `codePr` flight; absent for a `nodeRef` flight. */
    codePr: z
      .object({
        prNumber: z.number().int().positive(),
      })
      .optional(),
    workflowUrl: z.string().url(),
    message: z.string(),
  }),
} as const;
