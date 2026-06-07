// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/vcs-flight-candidate`
 * Purpose: AI tool that dispatches the `candidate-flight.yml` workflow for a nodeRef.
 * Scope: State-changing CI dispatch — thin wrapper over VcsCapability.dispatchCandidateFlight; does not import LangChain, does not check CI prerequisites (the workflow owns that), does not poll for the resulting run_id (racey).
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__vcs_flight_candidate`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - NO_AUTO_FLIGHT: enforced by prompt and tool description, not code. Agent must be
 *     explicitly instructed; the workflow itself owns slot lease + CI prerequisites.
 * Side-effects: IO (dispatches GitHub Actions workflow via VcsCapability)
 * Links: task.0297, task.0242
 * @public
 */

import { z } from "zod";

import type { VcsCapability } from "../capabilities/vcs";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const VcsFlightCandidateInputSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (e.g., 'Cogni-DAO')"),
  repo: z.string().min(1).describe("Operator repository name (e.g., 'cogni')"),
  nodeSlug: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe("Catalog node slug to flight to candidate-a"),
  sourceSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .describe(
      "External node repo source SHA. The child repo must publish image_repository:sha-<sourceSha>."
    ),
  workflowRef: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional branch/ref from which to load candidate-flight.yml. Defaults to " +
        "'main'. Set to a feature branch to test workflow changes before merging."
    ),
});
export type VcsFlightCandidateInput = z.infer<
  typeof VcsFlightCandidateInputSchema
>;

export const VcsFlightCandidateOutputSchema = z.object({
  dispatched: z.boolean(),
  nodeSlug: z.string(),
  sourceSha: z.string(),
  workflowUrl: z.string().url(),
  message: z.string(),
});
export type VcsFlightCandidateOutput = z.infer<
  typeof VcsFlightCandidateOutputSchema
>;

export type VcsFlightCandidateRedacted = VcsFlightCandidateOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const VCS_FLIGHT_CANDIDATE_NAME = "core__vcs_flight_candidate" as const;

export const vcsFlightCandidateContract: ToolContract<
  typeof VCS_FLIGHT_CANDIDATE_NAME,
  VcsFlightCandidateInput,
  VcsFlightCandidateOutput,
  VcsFlightCandidateRedacted
> = {
  name: VCS_FLIGHT_CANDIDATE_NAME,
  description:
    "Dispatch the `candidate-flight.yml` workflow for an external node source revision. " +
    "Promotes the node artifact digest onto `deploy/candidate-a` and waits for " +
    "Argo to roll the candidate-a pods. " +
    "The child repo must already have published image_repository:sha-<sourceSha>; " +
    "do not use PR numbers as artifact identity. " +
    "Do NOT auto-flight: only call when a human or scheduled run has explicitly " +
    "requested it. Only one flight per agent run. After this call, use " +
    "the workflow URL to observe the resulting `candidate-flight` run.",
  effect: "state_change",
  inputSchema: VcsFlightCandidateInputSchema,
  outputSchema: VcsFlightCandidateOutputSchema,
  redact: (output: VcsFlightCandidateOutput): VcsFlightCandidateRedacted =>
    output,
  allowlist: [
    "dispatched",
    "nodeSlug",
    "sourceSha",
    "workflowUrl",
    "message",
  ] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface VcsFlightCandidateDeps {
  readonly vcsCapability: VcsCapability;
}

export function createVcsFlightCandidateImplementation(
  deps: VcsFlightCandidateDeps
): ToolImplementation<VcsFlightCandidateInput, VcsFlightCandidateOutput> {
  return {
    execute: async (
      input: VcsFlightCandidateInput
    ): Promise<VcsFlightCandidateOutput> => {
      return deps.vcsCapability.dispatchCandidateFlight({
        owner: input.owner,
        repo: input.repo,
        nodeSlug: input.nodeSlug,
        sourceSha: input.sourceSha,
        workflowRef: input.workflowRef,
      });
    },
  };
}

export const vcsFlightCandidateStubImplementation: ToolImplementation<
  VcsFlightCandidateInput,
  VcsFlightCandidateOutput
> = {
  execute: async (): Promise<VcsFlightCandidateOutput> => {
    throw new Error("VcsCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const vcsFlightCandidateBoundTool: BoundTool<
  typeof VCS_FLIGHT_CANDIDATE_NAME,
  VcsFlightCandidateInput,
  VcsFlightCandidateOutput,
  VcsFlightCandidateRedacted
> = {
  contract: vcsFlightCandidateContract,
  implementation: vcsFlightCandidateStubImplementation,
};
