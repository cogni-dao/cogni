// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/vcs-merge-pr`
 * Purpose: AI tool that merges a pull request via the GitHub API.
 * Scope: State-changing PR merge. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__vcs_merge_pr`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - Agent must verify CI green + approval before calling (enforced by prompt, not code)
 * Side-effects: IO (merges PR via VcsCapability)
 * Links: task.0242
 * @public
 */

import { z } from "zod";

import type { VcsCapability } from "../capabilities/vcs";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const VcsMergePrInputSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (e.g., 'Cogni-DAO')"),
  repo: z.string().min(1).describe("Repository name (e.g., 'node-template')"),
  prNumber: z.number().int().min(1).describe("Pull request number to merge"),
  method: z
    .enum(["squash", "merge", "rebase"])
    .describe("Merge method. Use 'squash' for accepted feature PRs."),
});
export type VcsMergePrInput = z.infer<typeof VcsMergePrInputSchema>;

export const VcsMergePrOutputSchema = z.object({
  merged: z.boolean(),
  sha: z.string().optional(),
  message: z.string(),
});
export type VcsMergePrOutput = z.infer<typeof VcsMergePrOutputSchema>;

export type VcsMergePrRedacted = VcsMergePrOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const VCS_MERGE_PR_NAME = "core__vcs_merge_pr" as const;

export const vcsMergePrContract: ToolContract<
  typeof VCS_MERGE_PR_NAME,
  VcsMergePrInput,
  VcsMergePrOutput,
  VcsMergePrRedacted
> = {
  name: VCS_MERGE_PR_NAME,
  description:
    "Merge a pull request. IMPORTANT: Always check CI status and review approval " +
    "with core__vcs_get_ci_status before merging. " +
    "The normal code target is main; preview and production are promoted later by the deploy plane. " +
    "Use 'squash' for accepted feature PRs.",
  effect: "state_change",
  inputSchema: VcsMergePrInputSchema,
  outputSchema: VcsMergePrOutputSchema,
  redact: (output: VcsMergePrOutput): VcsMergePrRedacted => output,
  allowlist: ["merged", "sha", "message"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface VcsMergePrDeps {
  readonly vcsCapability: VcsCapability;
}

export function createVcsMergePrImplementation(
  deps: VcsMergePrDeps
): ToolImplementation<VcsMergePrInput, VcsMergePrOutput> {
  return {
    execute: async (input: VcsMergePrInput): Promise<VcsMergePrOutput> => {
      return deps.vcsCapability.mergePr({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        method: input.method,
      });
    },
  };
}

export const vcsMergePrStubImplementation: ToolImplementation<
  VcsMergePrInput,
  VcsMergePrOutput
> = {
  execute: async (): Promise<VcsMergePrOutput> => {
    throw new Error("VcsCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const vcsMergePrBoundTool: BoundTool<
  typeof VCS_MERGE_PR_NAME,
  VcsMergePrInput,
  VcsMergePrOutput,
  VcsMergePrRedacted
> = {
  contract: vcsMergePrContract,
  implementation: vcsMergePrStubImplementation,
};
