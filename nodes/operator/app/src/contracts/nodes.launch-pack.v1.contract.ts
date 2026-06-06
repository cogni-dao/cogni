// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/nodes.launch-pack.v1`
 * Purpose: Owner-gated AI-assistant handoff contract for the node wizard.
 * Scope: Stable wire shape for `/api/v1/nodes/[id]/launch-pack`.
 * Side-effects: none
 * Links: src/features/nodes/launch-pack.ts, node-launch-handoff
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
    nodeId: z.string().uuid(),
  }),
  output: z.object({
    kind: z.literal("cogni.node.launch_pack.v0"),
    nodeId: z.string().uuid(),
    slug: z.string().min(1),
    status: NodeLaunchPackStatusSchema,
    operatorBaseUrl: z.string().url(),
    launchPackUrl: z.string().url(),
    nodeRepoUrl: z.string().url().nullable(),
    parentDeploymentPrUrl: z.string().url().nullable(),
    candidateUrl: z.string().url(),
    knowledgeBlock: z.object({
      id: z.literal("node-launch-handoff"),
      title: z.literal("AI assistant launch pack for node birth"),
      url: z.string().url(),
    }),
    prompt: z.string().min(1),
  }),
} as const;

export type NodeLaunchPackOutput = z.infer<
  typeof nodeLaunchPackOperation.output
>;
