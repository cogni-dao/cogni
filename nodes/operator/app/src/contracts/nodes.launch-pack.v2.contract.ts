// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/nodes.launch-pack.v2`
 * Purpose: Versioned launch handoff pointing at maintained canonical knowledge.
 * Scope: Successor of the retained v1 contract; owner authorization stays at delivery.
 * Side-effects: none
 * Links: nodes.launch-pack.v1.contract.ts, cicd-e2e-required-sequence, bug.5388
 * @public
 */

import { z } from "zod";

import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";

export const nodeLaunchPackV2Operation = {
  id: "nodes.launch-pack.v2",
  input: nodeLaunchPackOperation.input,
  output: nodeLaunchPackOperation.output.extend({
    kind: z.literal("cogni.node.launch_pack.v1"),
    knowledgeBlock: z.object({
      id: z.literal("cicd-e2e-required-sequence"),
      title: z.literal("Ship a node change through the operator"),
      url: z.string().url(),
    }),
  }),
} as const;

export type NodeLaunchPackV2Output = z.infer<
  typeof nodeLaunchPackV2Operation.output
>;
