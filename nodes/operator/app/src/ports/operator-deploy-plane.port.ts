// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-deploy-plane`
 * Purpose: Operator-local deploy control plane for candidate flight dispatch.
 * Scope: Interface only. Keeps hosted deploy operations out of shared AI-tool capabilities.
 * Invariants:
 *   - OPERATOR_OWNS_DEPLOY: deploy mutations target the operator parent repo/workflows.
 *   - PARENT_PIN_GATES_NODE_REF: node-ref flight dispatch requires an accepted parent gitlink pin
 *     or an exact green parent pin PR head.
 * Side-effects: none
 * Links: docs/spec/node-ci-cd-contract.md, src/app/api/v1/vcs/flight/route.ts
 * @public
 */

export interface OperatorDeployCheckInfo {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface OperatorDeployCiStatus {
  readonly prNumber: number;
  readonly headSha: string;
  readonly allGreen: boolean;
  readonly pending: boolean;
  readonly checks: readonly OperatorDeployCheckInfo[];
}

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

export interface OperatorDeployPlanePort {
  getCiStatus(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<OperatorDeployCiStatus>;

  prepareNodeRefCandidateFlight(
    input: PrepareNodeRefCandidateFlightInput
  ): Promise<PreparedNodeRefCandidateFlight>;

  dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult>;
}
