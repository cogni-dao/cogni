// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/nodes.flight.v1`
 * Purpose: Stable wire contract for node-ref deploy flights.
 * Scope: Contract only. Runtime validation and dispatch live in the route.
 * Side-effects: none
 * Links: docs/spec/node-ci-cd-contract.md
 * @public
 */

import { z } from "zod";

export const NodeFlightEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

export const nodeFlightOperation = {
  id: "nodes.flight.v1",
  input: z.object({
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
    environment: NodeFlightEnvironmentSchema.default("candidate-a"),
  }),
  output: z.object({
    dispatched: z.boolean(),
    nodeRef: z.string().min(1),
    slug: z.string().min(1),
    nodeId: z.string().uuid(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
    environment: NodeFlightEnvironmentSchema,
    sourceRepo: z.string().url(),
    image: z.string().min(1),
    workflowUrl: z.string().url(),
    message: z.string(),
  }),
} as const;

export type NodeFlightEnvironment = z.infer<typeof NodeFlightEnvironmentSchema>;
export type NodeFlightInput = z.infer<typeof nodeFlightOperation.input>;
export type NodeFlightOutput = z.infer<typeof nodeFlightOperation.output>;
