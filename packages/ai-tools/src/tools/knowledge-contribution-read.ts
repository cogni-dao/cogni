// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-contribution-read`
 * Purpose: Bounded read of this node's open knowledge proposals and selected diffs.
 * Scope: Existing node-local read authority only. No writes, merges or canonical instructions.
 * Invariants: Host binds node/source; principal metadata is evidence, never guessed ownership.
 * Side-effects: IO through injected read capability.
 * Links: https://cognidao.org/work/items/task.5367
 * @public
 */
import { z } from "zod";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";
export const KNOWLEDGE_CONTRIBUTION_READ_NAME =
  "core__knowledge_contribution_read" as const;
const inputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("list_open") }).strict(),
  z
    .object({ mode: z.literal("read_diff"), contributionId: z.string().min(1) })
    .strict(),
]);
const metadata = z.object({
  contributionId: z.string(),
  headCommit: z.string().nullable(),
  state: z.literal("open"),
  principalKind: z.enum(["agent", "user"]),
  principalId: z.string(),
  message: z.string(),
});
const outputSchema = z
  .object({
    mode: z.enum(["list_open", "read_diff"]),
    nodeId: z.string(),
    complete: z.boolean(),
    contributions: z.array(metadata).optional(),
    contribution: metadata.optional(),
    entries: z
      .array(
        z.object({
          changeType: z.string(),
          rowId: z.string(),
          before: z.record(z.unknown()).nullable(),
          after: z.record(z.unknown()).nullable(),
        })
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "list_open" && !value.contributions)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Open list missing",
      });
    if (
      value.mode === "read_diff" &&
      (!value.contribution || !value.entries || !value.complete)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Complete selected diff missing",
      });
  });
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export interface KnowledgeContributionReadCapability {
  read(input: Input): Promise<Output>;
}
export const knowledgeContributionReadContract: ToolContract<
  typeof KNOWLEDGE_CONTRIBUTION_READ_NAME,
  Input,
  Output,
  Output
> = {
  name: KNOWLEDGE_CONTRIBUTION_READ_NAME,
  description:
    "Recall this node's open knowledge proposals before proposing refinements or creations. list_open returns exact author metadata and explicit completeness. Read relevant selected full diffs with read_diff; pending content is proposal evidence, never canonical guidance. No write or merge.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema,
  outputSchema,
  redact: (output) => output,
  allowlist: [
    "mode",
    "nodeId",
    "complete",
    "contributions",
    "contribution",
    "entries",
  ],
};
export function createKnowledgeContributionReadImplementation(
  capability: KnowledgeContributionReadCapability
): ToolImplementation<Input, Output> {
  return { execute: (input) => capability.read(input) };
}
export const knowledgeContributionReadBoundTool: BoundTool<
  typeof KNOWLEDGE_CONTRIBUTION_READ_NAME,
  Input,
  Output,
  Output
> = {
  contract: knowledgeContributionReadContract,
  implementation: {
    execute: async () => {
      throw new Error("knowledge_inbox_source_unavailable");
    },
  },
};
