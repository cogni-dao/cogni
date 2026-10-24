// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/nodes.launch-pack.v1`
 * Purpose: Owner-gated AI-assistant handoff contract for the node wizard.
 * Scope: Stable wire keys with the maintained CI/CD guide as the primary knowledge pointer.
 * Side-effects: none
 * Links: src/features/nodes/launch-pack.ts, cicd-e2e-required-sequence, bug.5388
 * @public
 */

import { z } from "zod";

export const NodeLaunchPackStatusSchema = z.enum([
  "dao_pending",
  "dao_formed",
  "published",
  "wallet_ready",
  "payments_ready",
  "active",
  "failed",
]);

export const nodeLaunchPackOperation = {
  id: "nodes.launch-pack.v1",
  input: z.object({
    nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  }),
  output: z.object({
    kind: z.literal("cogni.node.launch_pack.v0"),
    nodeId: z.string().uuid(),
    slug: z.string().min(1),
    status: NodeLaunchPackStatusSchema,
    operatorBaseUrl: z.string().url(),
    launchPackUrl: z.string().url(),
    nodeRepoUrl: z.string().url().nullable(),
    knowledgeRepoUrl: z.string().url().nullable(),
    parentDeploymentPrUrl: z.string().url().nullable(),
    candidateUrl: z.string().url(),
    knowledgeBlock: z.object({
      id: z.literal("cicd-e2e-required-sequence"),
      title: z.literal("Ship a node change through the operator"),
      url: z.string().url(),
    }),
    prompt: z.string().min(1),
  }),
} as const;

export type NodeLaunchPackOutput = z.infer<
  typeof nodeLaunchPackOperation.output
>;
