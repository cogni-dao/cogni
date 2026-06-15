// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/vcs-create-branch`
 * Purpose: AI tool that creates a new branch in a GitHub repository.
 * Scope: State-changing branch creation. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__vcs_create_branch`
 *   - EFFECT_TYPED: effect is `state_change`
 * Side-effects: IO (creates branch via VcsCapability)
 * Links: task.0242
 * @public
 */

import { z } from "zod";

import type { VcsCapability } from "../capabilities/vcs";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const VcsCreateBranchInputSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (e.g., 'Cogni-DAO')"),
  repo: z.string().min(1).describe("Repository name (e.g., 'node-template')"),
  branch: z
    .string()
    .min(1)
    .describe(
      "New branch name (e.g., 'agent/task.0242/vcs-tools'). " +
        "Convention: agent/<work-item-id>/<description>"
    ),
  fromRef: z
    .string()
    .min(1)
    .describe(
      "Source ref to branch from — a branch name (e.g., 'main') or commit SHA"
    ),
});
export type VcsCreateBranchInput = z.infer<typeof VcsCreateBranchInputSchema>;

export const VcsCreateBranchOutputSchema = z.object({
  ref: z.string(),
  sha: z.string(),
});
export type VcsCreateBranchOutput = z.infer<typeof VcsCreateBranchOutputSchema>;

export type VcsCreateBranchRedacted = VcsCreateBranchOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const VCS_CREATE_BRANCH_NAME = "core__vcs_create_branch" as const;

export const vcsCreateBranchContract: ToolContract<
  typeof VCS_CREATE_BRANCH_NAME,
  VcsCreateBranchInput,
  VcsCreateBranchOutput,
  VcsCreateBranchRedacted
> = {
  name: VCS_CREATE_BRANCH_NAME,
  description:
    "Create a new branch in a GitHub repository from an existing ref. " +
    "Use branch naming convention: agent/<work-item-id>/<description>. " +
    "Branch from 'main' for normal feature work unless the task names a different base.",
  effect: "state_change",
  inputSchema: VcsCreateBranchInputSchema,
  outputSchema: VcsCreateBranchOutputSchema,
  redact: (output: VcsCreateBranchOutput): VcsCreateBranchRedacted => output,
  allowlist: ["ref", "sha"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface VcsCreateBranchDeps {
  readonly vcsCapability: VcsCapability;
}

export function createVcsCreateBranchImplementation(
  deps: VcsCreateBranchDeps
): ToolImplementation<VcsCreateBranchInput, VcsCreateBranchOutput> {
  return {
    execute: async (
      input: VcsCreateBranchInput
    ): Promise<VcsCreateBranchOutput> => {
      return deps.vcsCapability.createBranch({
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        fromRef: input.fromRef,
      });
    },
  };
}

export const vcsCreateBranchStubImplementation: ToolImplementation<
  VcsCreateBranchInput,
  VcsCreateBranchOutput
> = {
  execute: async (): Promise<VcsCreateBranchOutput> => {
    throw new Error("VcsCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const vcsCreateBranchBoundTool: BoundTool<
  typeof VCS_CREATE_BRANCH_NAME,
  VcsCreateBranchInput,
  VcsCreateBranchOutput,
  VcsCreateBranchRedacted
> = {
  contract: vcsCreateBranchContract,
  implementation: vcsCreateBranchStubImplementation,
};
