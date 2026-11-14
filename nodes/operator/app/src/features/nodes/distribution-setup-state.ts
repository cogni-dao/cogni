// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/distribution-setup-state`
 * Purpose: PURE derivation of the node distribution-setup stepper state from per-plane GROUND TRUTH.
 *   The setup spans three planes — (1) the on-chain distributor (deploy → transferOwnership(DAO)),
 *   (2) the git-authoritative activation record (repo-spec on the node's `main`, possibly still an
 *   OPEN activation PR), and (3) the on-chain ONE_TIME_AUTHORIZATION grant. Each step's state is
 *   derived from its own plane's truth, never from optimistic local component state, so a page
 *   refresh re-derives the identical view (story.5004 — the toks3 "reverted to baseline" bug).
 * Scope: Pure functions + types only. No IO, no hooks, no React. The card supplies chain reads
 *   (wagmi) and the record status (GET distributions-status route); this module only folds them.
 * Invariants:
 *   - GROUND_TRUTH_ONLY: inputs are plane truths (spec text on main, open-PR state, chain reads);
 *     outputs are a deterministic fold. Refresh-safe by construction.
 *   - OPEN_PR_IS_FIRST_CLASS: an unmerged activation PR derives `pr_open` — NEVER `not_recorded`.
 *     On-chain-succeeded-but-unrecorded derives `record_incomplete`/`not_recorded` with the
 *     distributor still visible — never hidden.
 *   - ORDERED_STEPS: deploy → authorize → record. The repo-spec cannot say active until both
 *     on-chain planes are verified; an open record PR is terminal and awaits merge.
 * Side-effects: none
 * Links: src/features/nodes/DistributionsCard.client.tsx,
 *   src/app/api/v1/nodes/[id]/distributions-status/route.ts,
 *   https://node-template.cognidao.org/knowledge/distribution-lifecycle ("Activation — one guided flow, git-authoritative")
 * @public
 */

/** An activation repo-spec PR on the node's own repo (opened by the operator GitHub App). */
export interface ActivationPrRef {
  /** PR number on the node repo. Null when only the URL is known (in-session fallback). */
  readonly number: number | null;
  readonly url: string;
}

/**
 * Plane-2 (git record) state, derived from the node repo-spec on `main` + open-PR state.
 * `pr_open` is FIRST-CLASS: the record exists but is unmerged — merge persists it.
 */
export type RecordPlaneState =
  | { readonly kind: "recorded" }
  | { readonly kind: "pr_open"; readonly pr: ActivationPrRef }
  | { readonly kind: "record_incomplete" }
  | { readonly kind: "not_recorded" };

/** Stepper display state. `awaiting` = complete at this surface, pending external settlement (merge). */
export type SetupStepState = "done" | "awaiting" | "current" | "pending";

export interface DistributionSetupInput {
  /** `distributions.status: active` (+ token/holder match) on the node repo-spec `main`. */
  readonly repoSpecActive: boolean;
  /** The OPEN activation PR on the node repo, if any (ground truth from the status route). */
  readonly openPr: ActivationPrRef | null;
  /** `distributions.distributor_address` recorded on `main`, if any. */
  readonly recordedDistributorAddress: string | null;
  /** `distributions.distributor_address` in the OPEN activation PR's branch spec, if any. */
  readonly pendingDistributorAddress: string | null;
  /** Distributor the connected wallet deployed THIS session (freshest known), if any. */
  readonly sessionDistributorAddress: string | null;
  /** Plane-1 chain proof: owner()==DAO AND token()==node token for the known distributor. */
  readonly distributorVerified: boolean;
  /** Plane-3 chain read: the wallet holds the scoped EXECUTE grant (`hasPermission === true`). */
  readonly authorized: boolean;
}

export interface DistributionSetupDerived {
  /** Best-known distributor address across planes (session > main record > open PR). */
  readonly distributorAddress: string | null;
  /** Where that address came from — drives the honest per-step caption. */
  readonly distributorSource: "session" | "repo-spec" | "activation-pr" | null;
  readonly recordPlane: RecordPlaneState;
  readonly steps: {
    readonly deploy: SetupStepState;
    readonly record: SetupStepState;
    readonly authorize: SetupStepState;
  };
  /** First step needing OWNER action; null when nothing is left to click. */
  readonly currentStep: 1 | 2 | 3 | null;
}

function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Fold per-plane ground truth into the guided-stepper state. Deterministic: the same inputs (a
 * refreshed page re-reading the same planes) always derive the same view.
 */
export function deriveDistributionSetup(
  input: DistributionSetupInput
): DistributionSetupDerived {
  const {
    repoSpecActive,
    openPr,
    recordedDistributorAddress,
    pendingDistributorAddress,
    sessionDistributorAddress,
    distributorVerified,
    authorized,
  } = input;

  // Plane 1 — the distributor. An address is only complete once the chain proves owner/token.
  const distributorAddress =
    sessionDistributorAddress ??
    recordedDistributorAddress ??
    pendingDistributorAddress;
  const distributorSource: DistributionSetupDerived["distributorSource"] =
    sessionDistributorAddress !== null
      ? "session"
      : recordedDistributorAddress !== null
        ? "repo-spec"
        : pendingDistributorAddress !== null
          ? "activation-pr"
          : null;
  const deployed = distributorAddress !== null && distributorVerified;

  // Plane 2 — the git record. `recorded` requires main to carry the FULL truth we know: when a
  // distributor is known, main must record that exact address (an active-but-addressless spec, or a
  // mismatched re-deploy, is an INCOMPLETE record — re-record, don't pretend).
  const mainRecordsKnownDistributor =
    distributorAddress === null ||
    sameAddress(recordedDistributorAddress, distributorAddress);
  const recorded = repoSpecActive && mainRecordsKnownDistributor;
  const recordPlane: RecordPlaneState = recorded
    ? { kind: "recorded" }
    : openPr !== null
      ? { kind: "pr_open", pr: openPr }
      : repoSpecActive
        ? { kind: "record_incomplete" }
        : { kind: "not_recorded" };

  // The record is terminal: activation is written only after deploy + CAS authorization verify.
  const recordNeedsOwnerAction =
    recordPlane.kind === "not_recorded" ||
    recordPlane.kind === "record_incomplete";

  const currentStep: DistributionSetupDerived["currentStep"] = !deployed
    ? 1
    : !authorized
      ? 2
      : recordNeedsOwnerAction
        ? 3
        : null;

  const steps = {
    deploy: (deployed
      ? "done"
      : currentStep === 1
        ? "current"
        : "pending") as SetupStepState,
    record: (recordPlane.kind === "recorded"
      ? "done"
      : recordPlane.kind === "pr_open"
        ? "awaiting"
        : currentStep === 3
          ? "current"
          : "pending") as SetupStepState,
    authorize: (authorized
      ? "done"
      : currentStep === 2
        ? "current"
        : "pending") as SetupStepState,
  };

  return {
    distributorAddress,
    distributorSource,
    recordPlane,
    steps,
    currentStep,
  };
}
