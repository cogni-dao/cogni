// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/node-code-list`
 * Purpose: Inspect direct admitted code entries at the owning node's immutable serving commit.
 * Scope: Bounded tree metadata only; no arbitrary refs, recursive traversal or writes.
 * Invariants: Existing developer authority; capped/inaccessible trees cannot prove absence.
 * Side-effects: IO via injected NodeCodeCapability.
 * Links: https://cognidao.org/work/items/subtask.5027
 * @public
 */
import { z } from "zod";
import type { NodeCodeCapability } from "../capabilities/node-code";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";
import { NodeCodeSourceSchema } from "./node-code-read";

export const NODE_CODE_LIST_NAME = "core__node_code_list" as const;
export const NodeCodeListInputSchema = z
  .object({ path: z.string().min(1).max(512) })
  .strict();
export const NodeCodeListOutputSchema = NodeCodeSourceSchema.extend({
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory"]),
      sha: z.string().regex(/^[0-9a-f]{40}$/),
    })
  ),
});
type Input = z.infer<typeof NodeCodeListInputSchema>;
type Output = z.infer<typeof NodeCodeListOutputSchema>;
export const nodeCodeListContract: ToolContract<
  typeof NODE_CODE_LIST_NAME,
  Input,
  Output,
  Output
> = {
  name: NODE_CODE_LIST_NAME,
  description:
    "List direct admitted code children at this node's host-pinned full serving commit. Complete parent coverage plus an accessible commit is required to infer that a proposed path is absent. Omitted secret or disallowed paths confer no read permission; no writes.",
  effect: "read_only",
  requires: "node.flight",
  inputSchema: NodeCodeListInputSchema,
  outputSchema: NodeCodeListOutputSchema,
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
    "entries",
  ],
};
export function createNodeCodeListImplementation(deps: {
  nodeCodeCapability: NodeCodeCapability;
}): ToolImplementation<Input, Output> {
  return {
    execute: async (input) => {
      const output = await deps.nodeCodeCapability.list(input);
      return { ...output, entries: [...output.entries] };
    },
  };
}
export const nodeCodeListBoundTool: BoundTool<
  typeof NODE_CODE_LIST_NAME,
  Input,
  Output,
  Output
> = {
  contract: nodeCodeListContract,
  implementation: {
    execute: async () => {
      throw new Error("node_code_source_unavailable");
    },
  },
};
