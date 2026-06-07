// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-deploy-plane`
 * Purpose: Operator-local deploy control plane for candidate flight dispatch.
 * Scope: Interface only. Keeps hosted deploy operations out of shared AI-tool capabilities.
 * Invariants:
 *   - OPERATOR_OWNS_DEPLOY: deploy mutations target the operator parent repo/workflows.
 *   - NODE_REF_PREFLIGHT_VALIDATES: node-ref flight dispatch validates source commit,
 *     repo identity, catalog entry, and image tag before dispatch.
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

export interface ValidateNodeRefCandidateFlightInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
}

export interface ValidatedNodeRefCandidateFlight {
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
  readonly sourceRepo: string;
  readonly image: string;
}

export interface OperatorDeployPlanePort {
  getCiStatus(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<OperatorDeployCiStatus>;

  dispatchCandidateFlight(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  }): Promise<CandidateFlightDispatchResult>;

  validateNodeRefCandidateFlight(
    input: ValidateNodeRefCandidateFlightInput
  ): Promise<ValidatedNodeRefCandidateFlight>;

  dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult>;
}
