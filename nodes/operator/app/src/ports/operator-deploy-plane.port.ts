// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-deploy-plane`
 * Purpose: Operator-local deploy control plane for candidate flight dispatch.
 * Scope: Interface only. Keeps hosted deploy operations out of shared AI-tool capabilities.
 * Invariants:
 *   - OPERATOR_OWNS_DEPLOY: deploy mutations target the operator parent repo/workflows.
 *   - NODE_REF_ARTIFACT_GATE: node-ref flight dispatch requires a resolvable source artifact.
 *   - PREVIEW_VIA_FLIGHT_PREVIEW: node-merge preview promotion only lands the catalog
 *     source_sha pin on the parent main + enables auto-merge; flight-preview.yml (push:main)
 *     owns the actual promote. This route never dispatches promote-and-deploy directly —
 *     reuse the one preview primitive, no second promote path.
 * Side-effects: none
 * Links: docs/spec/node-ci-cd-contract.md, src/app/api/v1/vcs/flight/route.ts
 * @public
 */

export interface CandidateFlightDispatchResult {
  readonly dispatched: boolean;
  readonly workflowUrl: string;
  readonly message: string;
}

export interface PrepareNodeRefCandidateFlightInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
}

export type NodeRefParentPin =
  | {
      readonly status: "already_pinned";
      readonly currentSha: string;
      readonly prNumber?: undefined;
      readonly prUrl?: undefined;
      readonly parentHeadSha?: undefined;
    }
  | {
      readonly status: "pin_pr_opened";
      readonly currentSha: string | null;
      readonly prNumber: number;
      readonly prUrl: string;
      readonly parentHeadSha: string;
    };

export interface PreparedNodeRefCandidateFlight {
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
  readonly sourceRepo: string;
  readonly image: string;
  readonly parentPin: NodeRefParentPin;
}

export interface PromoteNodeToPreviewInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly slug: string;
  /** Node-repo PR head commit SHA — the build the node's PR CI published as `sha-<sourceSha>`. */
  readonly sourceSha: string;
}

export type NodePreviewPromoteResult =
  | { readonly status: "already_pinned"; readonly currentSha: string }
  | {
      readonly status: "pin_pr_opened";
      readonly prNumber: number;
      readonly prUrl: string;
      readonly currentSha: string | null;
      readonly autoMergeEnabled: boolean;
    };

export interface OperatorDeployPlanePort {
  prepareNodeRefCandidateFlight(
    input: PrepareNodeRefCandidateFlightInput
  ): Promise<PreparedNodeRefCandidateFlight>;

  dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult>;

  /**
   * On a node-repo PR merge: bump the parent catalog `source_sha` pin to `sourceSha` and
   * enable auto-merge on the resulting one-line PR. Landing that PR on parent main is what
   * triggers flight-preview.yml — the operator never dispatches promote-and-deploy here
   * (PREVIEW_VIA_FLIGHT_PREVIEW). Idempotent: returns `already_pinned` when preview already
   * tracks this SHA.
   */
  promoteNodeToPreview(
    input: PromoteNodeToPreviewInput
  ): Promise<NodePreviewPromoteResult>;
}
