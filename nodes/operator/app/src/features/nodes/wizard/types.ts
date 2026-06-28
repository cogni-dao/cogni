// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/types`
 * Purpose: Shared prop contracts for the single-shell node setup wizard.
 * Scope: Pure types. `WizardNode` is the server-projected row + precomputed external URLs
 *   the client steps need; `WizardStepProps` is the uniform step contract.
 * Invariants: Steps are status-driven and stateless across reloads — the server row is the
 *   single resume point; no client-held step cursor.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts, src/features/nodes/wizard/step-registry.tsx
 * @public
 */

import type { FC } from "react";
import type { NodeStatus } from "@/shared/db/nodes";

export interface WizardNode {
  readonly id: string;
  readonly slug: string;
  readonly status: NodeStatus;
  readonly daoAddress: string | null;
  readonly chainId: number | null;
  readonly operatorWalletAddress: string | null;
  readonly splitAddress: string | null;
  readonly publishPrUrl: string | null;
  readonly failureReason: string | null;
  /** Precomputed server-side so client steps stay presentational. */
  readonly nodeRepoUrl: string | null;
  readonly knowledgeRepoUrl: string | null;
  readonly daoUrl: string | null;
  /** Direct GitHub link to the node's own `.cogni/repo-spec.yaml` — provenance for activation. */
  readonly repoSpecUrl: string | null;
  readonly paymentActivation: {
    readonly repoSpecActive: boolean;
    readonly sourceSha: string | null;
    readonly activationPrUrl: string | null;
    readonly activationPrState: "open" | "merged" | null;
    readonly productionBuildSha: string | null;
    readonly productionMatchesSource: boolean;
  } | null;
}

export interface WizardStepProps {
  readonly node: WizardNode;
}

export type WizardStepComponent = FC<WizardStepProps>;
