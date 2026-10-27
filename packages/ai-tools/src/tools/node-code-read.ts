// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/node-code-read`
 * Purpose: Read an admitted source range at the owning node's immutable serving commit.
 * Scope: No model-selected repository, node, origin, credential or revision; no writes.
 * Invariants: Existing node.flight developer authorization is required, never node.collaborate.
 * Side-effects: IO via injected NodeCodeCapability.
 * Links: https://cognidao.org/work/items/subtask.5027
 * @public
 */
import { z } from "zod";
import type { NodeCodeCapability } from "../capabilities/node-code";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const NODE_CODE_READ_NAME = "core__node_code_read" as const;
export const NodeCodeSourceSchema = z.object({
  nodeId: z.string().min(1),
  origin: z.string().url(),
  repo: z.string().min(1),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string(),
  citation: z.string(),
  complete: z.boolean(),
  exists: z.boolean().nullable(),
  reason: z.string().optional(),
});
export const NodeCodeReadInputSchema = z
  .object({
    path: z.string().min(1).max(512),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
  })
  .strict();
export const NodeCodeReadOutputSchema = NodeCodeSourceSchema.extend({
  content: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  lineStart: z.number().int().min(0).nullable(),
  lineEnd: z.number().int().min(0).nullable(),
  totalLines: z.number().int().min(0).nullable(),
  fileComplete: z.boolean(),
});
type Input = z.infer<typeof NodeCodeReadInputSchema>;
type Output = z.infer<typeof NodeCodeReadOutputSchema>;
export const nodeCodeReadContract: ToolContract<
  typeof NODE_CODE_READ_NAME,
  Input,
  Output,
  Output
> = {
  name: NODE_CODE_READ_NAME,
  description:
    "Read an allowed code path at this node's host-pinned full serving commit. Returns exact range bytes, hash and citation. Requires existing node developer authority. Incomplete or inaccessible evidence never proves absence; no shell or writes.",
  effect: "read_only",
  requires: "node.flight",
  inputSchema: NodeCodeReadInputSchema,
  outputSchema: NodeCodeReadOutputSchema,
  redact: (output) => output,
  allowlist: [
    "nodeId",
    "origin",
    "repo",
    "commitSha",
    "path",
    "citation",
    "complete",
    "exists",
    "reason",
    "content",
    "sha256",
    "lineStart",
    "lineEnd",
    "totalLines",
    "fileComplete",
  ],
};
export function createNodeCodeReadImplementation(deps: {
  nodeCodeCapability: NodeCodeCapability;
}): ToolImplementation<Input, Output> {
  return { execute: async (input) => deps.nodeCodeCapability.read(input) };
}
export const nodeCodeReadBoundTool: BoundTool<
  typeof NODE_CODE_READ_NAME,
  Input,
  Output,
  Output
> = {
  contract: nodeCodeReadContract,
  implementation: {
    execute: async () => {
      throw new Error("node_code_source_unavailable");
    },
  },
};
