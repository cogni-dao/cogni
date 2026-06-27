// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/step-registry`
 * Purpose: Status → step-component map. The single place that binds a node status to the
 *   panel that renders it — order-agnostic by construction.
 * Scope: Pure lookup. Stage *ordering* lives in `state-machine.ts` (TRANSITIONS +
 *   NODE_PROGRESS_STEPS); reordering stages requires no change here. `available:false` marks
 *   long-tail stages whose flow is not yet built.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts (ordering SSOT), ./types.ts
 * @public
 */

import type { NodeStatus } from "@/shared/db/nodes";

import { DaoStep } from "./steps/DaoStep.client";
import { HandoffStep } from "./steps/HandoffStep.client";
import { RepoStep } from "./steps/RepoStep.client";
import { ActiveStep, FailedStep, PaymentsStep } from "./steps/SimpleSteps";
import type { WizardStepComponent } from "./types";

export interface WizardStepEntry {
  readonly Component: WizardStepComponent;
  /** false ⇒ designed "coming soon" placeholder (flow not yet built). */
  readonly available: boolean;
}

export const WIZARD_STEP_REGISTRY: Record<NodeStatus, WizardStepEntry> = {
  dao_pending: { Component: DaoStep, available: true },
  dao_formed: { Component: RepoStep, available: true },
  published: { Component: HandoffStep, available: true },
  wallet_ready: { Component: HandoffStep, available: true },
  payments_ready: { Component: PaymentsStep, available: false },
  active: { Component: ActiveStep, available: true },
  failed: { Component: FailedStep, available: true },
};
