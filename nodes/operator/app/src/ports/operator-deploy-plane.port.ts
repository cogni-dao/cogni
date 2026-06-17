// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-deploy-plane`
 * Purpose: Operator-local deploy control plane for candidate flight dispatch.
 * Scope: Interface only. Keeps hosted deploy operations out of shared AI-tool capabilities.
 * Invariants:
 *   - OPERATOR_OWNS_DEPLOY: deploy mutations target the operator parent repo/workflows.
 *   - NODE_REF_ARTIFACT_GATE: node-ref flight dispatch requires a resolvable source artifact.
 *   - ONE_PROMOTION_PRIMITIVE: every promotion rung (candidate-a, preview, production)
 *     dispatches `promote-and-deploy.yml` directly via the operator App — no rung routes
 *     through a code-branch PR. Preview is SOURCE-ADDRESSED by the node image sha
 *     (`node_source_sha` input, like candidate-flight): the workflow resolves the image from
 *     the input and records the pin on `deploy/preview`, writing ZERO commits to `main`
 *     (task.5022; the App's main-write privilege is reserved for governance/code merges).
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

export interface NodePreviewPromoteResult {
  /**
   * Always `dispatched`: preview mirrors production (ONE_PROMOTION_PRIMITIVE). The node sha is
   * source-addressed on the dispatch (no main write, no PR), so there is no `already_pinned`
   * branch — the pin lands on `deploy/preview` as part of the promote run.
   */
  readonly status: "dispatched";
  /** Node-repo PR head SHA promoted — the `node_source_sha` the workflow pins. */
  readonly sourceSha: string;
  readonly workflowUrl: string;
}

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
   * On a node-repo PR merge: promote the node to preview the same way production promotes
   * (ONE_PROMOTION_PRIMITIVE), source-addressed by the node head sha. Dispatches
   * `promote-and-deploy.yml` at env=preview with `node_source_sha` so the workflow resolves the
   * node image from the input (not a catalog read) and records the pin on `deploy/preview`.
   * Writes ZERO commits to `main`. Validates that the parent catalog row exists/identifies the
   * slug but reads nothing from it for resolution.
   */
  promoteNodeToPreview(
    input: PromoteNodeToPreviewInput
  ): Promise<NodePreviewPromoteResult>;

  /**
   * Promote a node to an environment by dispatching `promote-and-deploy.yml` via the operator App.
   * Authorization (`node.promote_production` for prod) is enforced at the route BEFORE this is called.
   * `sourceSha` is the operator-repo checkout ref (optional — omit it for production preview-forward
   * mode); never pass a child SHA there. `nodeSourceSha` source-addresses a remote-source node's
   * image (preview promote): present ⇒ the workflow pins it; absent ⇒ the workflow reads the catalog
   * `source_sha` pin (`CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN`, production unchanged).
   */
  dispatchNodePromote(input: {
    owner: string;
    repo: string;
    env: string;
    slug: string;
    sourceSha?: string;
    nodeSourceSha?: string;
  }): Promise<CandidateFlightDispatchResult>;
}
